import fs from "node:fs/promises";
import path from "node:path";

import { authDigest, parseAuthText } from "./auth-file.js";
import { mergeAccountConfigText, readCurrentProviderFromConfigText } from "./config-file.js";
import { DEFAULT_PROVIDER, codexPaths } from "./constants.js";
import { fileExists, fileModeOr, isNotFound, readTextIfExists, writeFileAtomically } from "./fs-utils.js";
import { LOCK_BUSY_CODE, acquireLock, withLock } from "./locking.js";
import {
  AUTH_SNAPSHOT_SUFFIX,
  accountDisplayName,
  ensureAccountsDir,
  findSingleAccount,
  listAccounts,
  readRegistry,
  snapshotPaths,
  writeRegistry
} from "./registry.js";

/** @typedef {import("./auth-file.js").AuthIdentity} AuthIdentity */
/** @typedef {import("./registry.js").Account} Account */
/** @typedef {import("./registry.js").Registry} Registry */

/**
 * @typedef {object} AccountSummary
 * @property {string} accountKey
 * @property {string | null} email
 * @property {string} alias
 * @property {string | null} provider
 */

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The model provider config.toml selects, or null without a config.toml.
 * @param {string | null} configText
 */
function providerOf(configText) {
  return configText === null ? null : readCurrentProviderFromConfigText(configText).provider;
}

/** @param {string} codexHome */
async function readProviderFromConfig(codexHome) {
  return providerOf(await readTextIfExists(codexPaths(codexHome).config).catch(() => null));
}

/**
 * The ChatGPT login Codex is actually using. auth.json identifies an account
 * only while config.toml selects the OpenAI provider: a third-party provider
 * leaves the previous ChatGPT tokens in auth.json, and they may be long stale.
 * @param {string | null} authText
 * @param {string | null} configText
 */
function liveLoginOf(authText, configText) {
  return (providerOf(configText) ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER ? parseAuthText(authText) : null;
}

/**
 * When Codex last refreshed the tokens of an auth.json, or null when unknown.
 * @param {string | null} authText
 */
function lastRefreshMs(authText) {
  try {
    const value = Date.parse(JSON.parse(authText ?? "null")?.last_refresh);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {Registry} registry
 * @param {string} accountKey
 */
function markActive(registry, accountKey) {
  registry.active_account_key = accountKey;
  registry.active_account_activated_at_ms = Date.now();
}

/**
 * Codex refreshes OAuth tokens in auth.json while it runs. Saves them back to
 * the snapshot of the account they belong to. Refresh tokens are single-use, so
 * saving older tokens over newer ones would sign that account out: tokens a
 * third-party provider left in auth.json, or ones refreshed before the
 * snapshot's, are never saved.
 * @param {string} codexHome
 * @param {Registry} registry
 */
async function persistCurrentOAuthSnapshot(codexHome, registry) {
  const paths = codexPaths(codexHome);
  const authText = await readTextIfExists(paths.auth).catch(() => null);
  const parsed = liveLoginOf(authText, await readTextIfExists(paths.config).catch(() => null));
  if (authText === null || !parsed || !registry.accounts.some((account) => account.account_key === parsed.accountKey)) {
    return false;
  }
  const snapshotPath = snapshotPaths(codexHome, parsed.accountKey).auth;
  const liveRefresh = lastRefreshMs(authText);
  const snapshotRefresh = lastRefreshMs(await readTextIfExists(snapshotPath).catch(() => null));
  if (liveRefresh !== null && snapshotRefresh !== null && snapshotRefresh > liveRefresh) {
    return false;
  }
  await writeFileAtomically(snapshotPath, authText);
  return true;
}

/**
 * Saves the live config.toml back into the active account's snapshot, so model
 * or provider settings changed while that account was active survive a switch
 * away and back.
 * @param {string} codexHome
 * @param {Registry} registry
 */
async function persistCurrentConfigSnapshot(codexHome, registry) {
  const currentAccount = registry.accounts.find((account) => account.account_key === registry.active_account_key);
  if (!currentAccount) {
    return false;
  }

  const snapshotPath = snapshotPaths(codexHome, currentAccount.account_key).config;
  const liveText = await readTextIfExists(codexPaths(codexHome).config);
  const snapshotText = await readTextIfExists(snapshotPath);
  if (liveText === null || snapshotText === null) {
    return false;
  }

  // A config that was pointed at another provider by hand does not belong to
  // this account; never overwrite the account's snapshot with it.
  if (providerOf(liveText) !== providerOf(snapshotText)) {
    return false;
  }

  await writeFileAtomically(snapshotPath, liveText);
  return true;
}

/**
 * Brings the registry in line with the login in auth.json: Codex may have been
 * signed in to another registered account, or refreshed its tokens, since the
 * last cx run. Opportunistic: skipped when another cx run holds the lock. With
 * a third-party provider, auth.json does not say which account is in use.
 * @param {string} codexHome
 */
export async function syncActiveAccountFromCurrentAuth(codexHome) {
  const paths = codexPaths(codexHome);
  let parsed;
  try {
    parsed = liveLoginOf(await readTextIfExists(paths.auth), await readTextIfExists(paths.config));
  } catch {
    return false;
  }
  if (!parsed) {
    return false;
  }

  let releaseLock;
  try {
    releaseLock = await acquireLock(codexHome, "sync-active");
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === LOCK_BUSY_CODE) {
      return false;
    }
    throw error;
  }

  try {
    const registry = await readRegistry(codexHome);
    const match = registry.accounts.find((account) => account.account_key === parsed.accountKey);
    if (!match) {
      return false;
    }

    let changed = false;
    if (registry.active_account_key !== parsed.accountKey) {
      markActive(registry, parsed.accountKey);
      changed = true;
    }
    /** @type {Partial<Account>} */
    const updates = {
      chatgpt_account_id: parsed.accountId,
      chatgpt_user_id: parsed.userId,
      auth_mode: parsed.authMode,
      // Only the id_token carries the email; keep the known one when it is absent.
      ...(parsed.email ? { email: parsed.email } : {})
    };
    for (const [key, value] of Object.entries(updates)) {
      const field = /** @type {keyof Account} */ (key);
      if (match[field] !== value) {
        Object.assign(match, { [field]: value });
        changed = true;
      }
    }

    if (!changed) {
      return false;
    }
    match.last_used_at = nowSeconds();
    await writeRegistry(codexHome, registry);
    return true;
  } finally {
    await releaseLock();
  }
}

/**
 * Registers what ~/.codex holds now (auth.json and config.toml) as an account.
 * @param {string} codexHome
 * @param {string} [alias]
 * @returns {Promise<AccountSummary>}
 */
export async function addAccount(codexHome, alias) {
  const paths = codexPaths(codexHome);
  const authText = await readTextIfExists(paths.auth);
  const configText = await readTextIfExists(paths.config);

  if (authText === null && configText === null) {
    throw new Error(`Neither auth.json nor config.toml found in ${codexHome}. Nothing to add.`);
  }

  const provider = providerOf(configText);
  // A third-party login must not overwrite the registration of the ChatGPT
  // account whose tokens are left in auth.json.
  const parsed = liveLoginOf(authText, configText);

  if (!parsed && !alias) {
    throw new Error(`Cannot auto-detect account identity for provider "${provider ?? DEFAULT_PROVIDER}". Provide an alias: cx add <alias>`);
  }

  return withLock(codexHome, "add", () => registerAccount(codexHome, { parsed, alias, provider, authText, configText }));
}

/**
 * Writes the snapshots and the registry entry. Callers must hold the cx lock.
 * @param {string} codexHome
 * @param {{ parsed: AuthIdentity | null, alias?: string, provider: string | null, authText: string | null, configText: string | null }} login
 * @returns {Promise<AccountSummary>}
 */
async function registerAccount(codexHome, { parsed, alias, provider, authText, configText }) {
  const accountKey = parsed ? parsed.accountKey : `manual::${alias}`;

  await ensureAccountsDir(codexHome);
  const paths = snapshotPaths(codexHome, accountKey);
  // Snapshots hold OAuth tokens or API keys: keep them private to the owner.
  if (authText !== null) {
    await writeFileAtomically(paths.auth, authText);
  }
  if (configText !== null) {
    await writeFileAtomically(paths.config, configText);
  }

  const registry = await readRegistry(codexHome);
  // A ChatGPT login registered from auth.json is the live login now, and adding
  // the removed account back is deliberate: either way the removal is over.
  if (parsed || accountKey === registry.removed_account_key) {
    delete registry.removed_account_key;
  }
  if (parsed || (authText !== null && registry.removed_auth_sha256 === authDigest(authText))) {
    delete registry.removed_auth_sha256;
  }

  const now = nowSeconds();
  const existingIndex = registry.accounts.findIndex((account) => account.account_key === accountKey);
  const existing = existingIndex >= 0 ? registry.accounts[existingIndex] : null;
  /** @type {Account} */
  const accountEntry = {
    account_key: accountKey,
    chatgpt_account_id: parsed?.accountId ?? null,
    chatgpt_user_id: parsed?.userId ?? null,
    email: parsed?.email ?? existing?.email ?? null,
    alias: alias ?? existing?.alias ?? "",
    account_name: existing?.account_name ?? null,
    plan: existing?.plan ?? null,
    auth_mode: parsed?.authMode ?? "manual",
    provider: provider ?? null,
    created_at: existing?.created_at ?? now,
    last_used_at: now,
    last_usage: existing?.last_usage ?? null,
    last_usage_at: existing?.last_usage_at ?? null,
    last_local_rollout: existing?.last_local_rollout ?? null
  };
  if (existing) {
    registry.accounts[existingIndex] = accountEntry;
  } else {
    registry.accounts.push(accountEntry);
  }

  markActive(registry, accountKey);
  await writeRegistry(codexHome, registry);

  return { accountKey, email: accountEntry.email, alias: accountEntry.alias, provider };
}

/**
 * True when the outgoing credentials can be restored later, because an account
 * snapshot holds exactly this auth.json.
 * @param {string} codexHome
 * @param {string} authText
 */
async function isAuthSnapshotted(codexHome, authText) {
  const accountsDir = codexPaths(codexHome).accounts;
  let entries;
  try {
    entries = await fs.readdir(accountsDir);
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.endsWith(AUTH_SNAPSHOT_SUFFIX)
      && await readTextIfExists(path.join(accountsDir, entry)) === authText) {
      return true;
    }
  }
  return false;
}

/**
 * An API key or other non-OAuth login of the OpenAI provider exists only in
 * auth.json until a snapshot holds it, so replacing auth.json would lose it.
 * A login whose account was removed with `cx remove` was given up on purpose.
 * @param {string} codexHome
 */
async function hasUnsavedNonOAuthLogin(codexHome) {
  if ((await readProviderFromConfig(codexHome) ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER) {
    return false;
  }
  const authText = await readTextIfExists(codexPaths(codexHome).auth);
  if (authText === null || parseAuthText(authText) !== null) {
    return false;
  }
  if ((await readRegistry(codexHome)).removed_auth_sha256 === authDigest(authText)) {
    return false;
  }
  return !await isAuthSnapshotted(codexHome, authText);
}

/**
 * Third-party accounts and API keys have no browser login: what is in ~/.codex
 * is the account, so adding one snapshots it. An unsaved login of that kind must
 * be added before signing in, because the sign-in would replace it.
 * @param {string} codexHome
 */
export async function addNeedsLogin(codexHome) {
  if ((await readProviderFromConfig(codexHome) ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER) {
    return false;
  }
  return !await hasUnsavedNonOAuthLogin(codexHome);
}

/**
 * Saves the current login, then removes auth.json so Codex starts its own
 * sign-in. Removing the file matters: `codex login` and `codex logout` revoke
 * any tokens they find, which would invalidate the snapshot just saved.
 * @param {string} codexHome
 * @param {string | undefined} alias
 * @param {{ runCodex: () => Promise<unknown>, onCurrentSaved?: (saved: AccountSummary | null) => void }} hooks
 */
export async function addAccountWithLogin(codexHome, alias, { runCodex, onCurrentSaved }) {
  const authPath = codexPaths(codexHome).auth;
  const previousAuthText = await readTextIfExists(authPath);
  const previous = parseAuthText(previousAuthText);
  const { removed_account_key: removedAccountKey } = await readRegistry(codexHome);
  const saveCurrent = previous !== null && previous.accountKey !== removedAccountKey;
  onCurrentSaved?.(saveCurrent ? await addAccount(codexHome) : null);

  await fs.rm(authPath, { force: true });

  // Codex stays open after signing in, so its exit code says nothing about the
  // login; what it left in ~/.codex does.
  /** @type {unknown} */
  let runError = null;
  await runCodex().catch((error) => {
    runError = error;
  });

  const signedIn = await readTextIfExists(authPath) !== null || !await addNeedsLogin(codexHome);
  if (!signedIn) {
    if (previousAuthText !== null) {
      await writeFileAtomically(authPath, previousAuthText);
    }
    throw runError ?? new Error("No login was completed, so no account was added.");
  }

  const parsed = parseAuthText(await readTextIfExists(authPath));
  const accounts = await listAccounts(codexHome);
  const alreadyRegistered = accounts.some((account) => account.account_key === parsed?.accountKey);
  return { ...await addAccount(codexHome, alias), alreadyRegistered };
}

/**
 * A login that never reached the registry, such as one from an interrupted
 * `cx add`, has no snapshot: replacing auth.json would lose it. A login removed
 * with `cx remove` is left out.
 * @param {string} codexHome
 */
async function registerLiveLogin(codexHome) {
  const paths = codexPaths(codexHome);
  const authText = await readTextIfExists(paths.auth);
  const configText = await readTextIfExists(paths.config);
  const parsed = liveLoginOf(authText, configText);
  if (!parsed) {
    return;
  }

  const { accounts, removed_account_key: removedAccountKey } = await readRegistry(codexHome);
  if (parsed.accountKey !== removedAccountKey
    && !accounts.some((account) => account.account_key === parsed.accountKey)) {
    await registerAccount(codexHome, { parsed, provider: providerOf(configText), authText, configText });
  }
}

/**
 * Makes a registered account the live one: its auth.json, and its provider and
 * model settings merged into the live config.toml. Callers must hold the cx
 * lock (runSwitch does).
 * @param {string} codexHome
 * @param {string} identifier
 * @returns {Promise<AccountSummary>}
 */
export async function useAccount(codexHome, identifier) {
  if (!identifier) {
    throw new Error("Missing account identifier. Provide an email, alias, or account key.");
  }

  if (await hasUnsavedNonOAuthLogin(codexHome)) {
    throw new Error("The current login (an API key or other non-ChatGPT login) is not saved and switching would replace it. Save it first: cx add <alias>");
  }
  await registerLiveLogin(codexHome);
  const registry = await readRegistry(codexHome);
  const match = findSingleAccount(registry.accounts, identifier);

  const snapshot = snapshotPaths(codexHome, match.account_key);
  const hasAuthSnapshot = await fileExists(snapshot.auth);
  const hasConfigSnapshot = await fileExists(snapshot.config);
  if (!hasAuthSnapshot && !hasConfigSnapshot) {
    throw new Error(`No snapshot files found for "${accountDisplayName(match)}". Re-add the account.`);
  }

  // Codex refreshes OAuth tokens in auth.json while it is running. Preserve
  // that latest credential set before replacing auth.json with another
  // account, otherwise a later switch restores the stale tokens captured by the
  // original `cx add`. The same applies to the outgoing account's model and
  // provider settings in config.toml.
  await persistCurrentOAuthSnapshot(codexHome, registry);
  await persistCurrentConfigSnapshot(codexHome, registry);

  const paths = codexPaths(codexHome);
  if (hasAuthSnapshot) {
    await writeFileAtomically(paths.auth, await fs.readFile(snapshot.auth, "utf8"));
  } else {
    await fs.rm(paths.auth, { force: true });
  }

  if (hasConfigSnapshot) {
    // Only provider/model settings are per account. Projects, MCP servers and
    // other settings added since the snapshot was taken stay as they are.
    const snapshotText = await fs.readFile(snapshot.config, "utf8");
    const liveText = await readTextIfExists(paths.config);
    await writeFileAtomically(
      paths.config,
      liveText === null ? snapshotText : mergeAccountConfigText(liveText, snapshotText),
      { mode: await fileModeOr(paths.config, 0o600) }
    );
  }

  match.provider = (await readProviderFromConfig(codexHome)) ?? match.provider;
  match.last_used_at = nowSeconds();
  markActive(registry, match.account_key);
  // auth.json no longer holds the removed account's login.
  delete registry.removed_account_key;
  delete registry.removed_auth_sha256;
  await writeRegistry(codexHome, registry);

  return { accountKey: match.account_key, email: match.email, alias: match.alias, provider: match.provider };
}

/**
 * Deletes an account's snapshots and registry entry. Codex itself stays signed
 * in to whatever auth.json holds.
 * @param {string} codexHome
 * @param {string} identifier
 */
export async function removeAccount(codexHome, identifier) {
  if (!identifier) {
    throw new Error("Missing account identifier.");
  }

  return withLock(codexHome, "remove", async () => {
    const registry = await readRegistry(codexHome);
    const removed = findSingleAccount(registry.accounts, identifier);
    registry.accounts = registry.accounts.filter((account) => account !== removed);

    const snapshot = snapshotPaths(codexHome, removed.account_key);
    const removedAuthText = await readTextIfExists(snapshot.auth);
    await fs.rm(snapshot.auth, { force: true });
    await fs.rm(snapshot.config, { force: true });

    // auth.json may still hold the removed account's tokens, even ones a
    // third-party provider left there. Remember it, so that neither
    // `cx switch` nor `cx add` registers that login again on its own.
    const paths = codexPaths(codexHome);
    const liveAuthText = await readTextIfExists(paths.auth);
    const live = parseAuthText(liveAuthText);
    if (live?.accountKey === removed.account_key) {
      registry.removed_account_key = removed.account_key;
    }
    // An API key has no account key; remember it by digest, so that it no longer
    // counts as an unsaved login that blocks `cx switch` and `cx add`.
    if (!live && liveAuthText !== null && liveAuthText === removedAuthText) {
      registry.removed_auth_sha256 = authDigest(liveAuthText);
    }

    // A third-party account in use stays the active one.
    const inUse = liveLoginOf(liveAuthText, await readTextIfExists(paths.config))?.accountKey === removed.account_key;
    if (registry.active_account_key === removed.account_key || inUse) {
      registry.active_account_key = null;
      registry.active_account_activated_at_ms = null;
    }

    await writeRegistry(codexHome, registry);
    return { accountKey: removed.account_key, email: removed.email };
  });
}
