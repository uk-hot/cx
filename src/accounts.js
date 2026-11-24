import fs from "node:fs/promises";
import path from "node:path";

import { authDigest, loginIdentityOf, parseAuthText } from "./auth-file.js";
import { mergeAccountConfigText, readCurrentProviderFromConfigText } from "./config-file.js";
import { DEFAULT_PROVIDER, codexPaths } from "./constants.js";
import { fileExists, fileModeOr, isNotFound, readTextIfExists, writeFileAtomically } from "./fs-utils.js";
import { LOCK_BUSY_CODE, acquireLock, withLock, withLockWhenFree } from "./locking.js";
import {
  AUTH_SNAPSHOT_SUFFIX,
  accountDisplayName,
  ensureAccountsDir,
  findSingleAccount,
  readRegistry,
  snapshotPaths,
  writeRegistry
} from "./registry.js";
import { reassignThreadOwners, tryRecordSessionOwners } from "./session-owners.js";

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
export function liveLoginOf(authText, configText) {
  return (providerOf(configText) ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER ? parseAuthText(authText) : null;
}

/**
 * When Codex last refreshed the tokens of an auth.json, or null when unknown.
 * @param {string | null} authText
 */
export function lastRefreshMs(authText) {
  try {
    const value = Date.parse(JSON.parse(authText ?? "null")?.last_refresh);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * One person signing in two ways (Google, then a password) gets two registry
 * keys, because the key's `sub` names the sign-in method, yet it is one
 * ChatGPT login. Folds each such group into one account: `preferredKey` when it
 * is in the group, otherwise the one with the newest tokens. The others'
 * threads, alias and activation move to it. Callers hold the cx lock, write the
 * registry, then delete the folded accounts' snapshots (deleteSnapshots):
 * threads move first, so an interrupted fold just runs again.
 * @param {string} codexHome
 * @param {Registry} registry changed in place
 * @param {string | null} [preferredKey]
 * @returns {Promise<Map<string, string>>} each folded account key → the key it went into
 */
async function foldDuplicateLogins(codexHome, registry, preferredKey = null) {
  const paths = codexPaths(codexHome);
  const liveText = await readTextIfExists(paths.auth).catch(() => null);
  const liveKey = liveLoginOf(liveText, await readTextIfExists(paths.config).catch(() => null))?.accountKey ?? null;

  /** @type {Map<string, { account: Account, refreshedAt: number }[]>} */
  const groups = new Map();
  for (const account of registry.accounts) {
    const authText = await readTextIfExists(snapshotPaths(codexHome, account.account_key).auth).catch(() => null);
    const identity = loginIdentityOf(authText);
    if (!identity) {
      continue;
    }
    // Codex refreshes the live login's tokens in auth.json, not in its snapshot.
    const refreshes = [lastRefreshMs(authText), account.account_key === liveKey ? lastRefreshMs(liveText) : null];
    const refreshedAt = Math.max(-Infinity, ...refreshes.filter((value) => value !== null));
    groups.set(identity, [...groups.get(identity) ?? [], { account, refreshedAt }]);
  }

  /** @type {Map<string, string>} */
  const folded = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) {
      continue;
    }
    /** @param {{ account: Account, refreshedAt: number }} member */
    const rank = ({ account, refreshedAt }) => [account.account_key === preferredKey ? 1 : 0, refreshedAt, account.created_at ?? 0];
    members.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      const index = ra.findIndex((value, i) => value !== rb[i]);
      return index < 0 ? 0 : rb[index] - ra[index];
    });
    const [keep, ...rest] = members.map((member) => member.account);
    const restKeys = new Set(rest.map((account) => account.account_key));

    await reassignThreadOwners(codexHome, restKeys, keep.account_key);
    keep.alias ||= rest.find((account) => account.alias)?.alias ?? "";
    // Same login, so the same plan and quota.
    for (const field of /** @type {const} */ (["email", "account_name", "plan", "last_usage", "last_usage_at", "last_local_rollout"])) {
      if (keep[field] == null) {
        Object.assign(keep, { [field]: rest.find((account) => account[field] != null)?.[field] ?? null });
      }
    }
    const createdAt = [keep, ...rest].map((account) => account.created_at).filter(Number.isFinite);
    const lastUsedAt = [keep, ...rest].map((account) => account.last_used_at).filter(Number.isFinite);
    if (createdAt.length) {
      keep.created_at = Math.min(...createdAt);
    }
    if (lastUsedAt.length) {
      keep.last_used_at = Math.max(...lastUsedAt);
    }
    if (registry.active_account_key !== null && restKeys.has(registry.active_account_key)) {
      registry.active_account_key = keep.account_key;
    }
    registry.accounts = registry.accounts.filter((account) => !restKeys.has(account.account_key));
    for (const key of restKeys) {
      folded.set(key, keep.account_key);
    }
  }
  return folded;
}

/**
 * @param {string} codexHome
 * @param {Iterable<string>} accountKeys
 */
async function deleteSnapshots(codexHome, accountKeys) {
  for (const accountKey of accountKeys) {
    const snapshot = snapshotPaths(codexHome, accountKey);
    await fs.rm(snapshot.auth, { force: true });
    await fs.rm(snapshot.config, { force: true });
  }
}

/**
 * The registered account keys, and who each ChatGPT login among them is
 * (loginIdentityOf): a login matching either is a registered account.
 * @param {string} codexHome
 */
async function registeredLogins(codexHome) {
  const { accounts } = await readRegistry(codexHome);
  const identities = new Set();
  for (const account of accounts) {
    const identity = loginIdentityOf(await readTextIfExists(snapshotPaths(codexHome, account.account_key).auth).catch(() => null));
    if (identity) {
      identities.add(identity);
    }
  }
  return { keys: new Set(accounts.map((account) => account.account_key)), identities };
}

/**
 * Makes `accountKey` the active account, after crediting the threads used
 * since the previous activation to the outgoing account (see
 * session-owners.js). Callers hold the cx lock and write the registry after.
 * @param {string} codexHome
 * @param {Registry} registry
 * @param {string} accountKey
 * @param {AuthIdentity | null} liveLogin the login auth.json holds before the change
 */
async function markActive(codexHome, registry, accountKey, liveLogin) {
  await tryRecordSessionOwners(codexHome, registry, { liveLogin });
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
  const snapshotText = await readTextIfExists(snapshotPath).catch(() => null);
  const liveRefresh = lastRefreshMs(authText);
  const snapshotRefresh = lastRefreshMs(snapshotText);
  if (snapshotText === authText || (liveRefresh !== null && snapshotRefresh !== null && snapshotRefresh > liveRefresh)) {
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
 * signed in to another account, or refreshed its tokens, since the last cx run.
 * Saves that login: a new one is registered (Codex signing in on its own after
 * `cx switch` to a signed-out account, say), a registered one's snapshot gets
 * its newer tokens. Also folds accounts registered twice for one person signed in
 * two ways (foldDuplicateLogins). Opportunistic: skipped when another cx run
 * holds the lock. With a third-party provider, auth.json does not say which
 * account is in use.
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
    // Only a live login was ever synced here: folding alone must not fail the
    // command over an unreadable registry or thread owner file.
    const readRegistryOrNull = () => readRegistry(codexHome).catch((error) => {
      if (parsed) {
        throw error;
      }
      return null;
    });
    let registry = await readRegistryOrNull();
    /** @type {Map<string, string>} */
    let folded = new Map();
    try {
      folded = registry ? await foldDuplicateLogins(codexHome, registry) : folded;
    } catch {
      // Nothing changed on disk; the next run tries again.
      registry = await readRegistryOrNull();
    }
    if (!registry) {
      return false;
    }
    const finalRegistry = registry;
    const save = async () => {
      await writeRegistry(codexHome, finalRegistry);
      await deleteSnapshots(codexHome, folded.keys());
      return true;
    };
    if (!parsed) {
      return folded.size > 0 ? save() : false;
    }
    const match = registry.accounts.find((account) => account.account_key === parsed.accountKey);
    if (!match) {
      if (folded.size > 0) {
        await save();
      }
      return await registerLiveLogin(codexHome) || folded.size > 0;
    }

    let changed = false;
    if (registry.active_account_key !== parsed.accountKey) {
      // Codex was signed in to another account behind cx's back, at a time cx
      // doesn't know: only creator tags can say whose the recent threads are.
      await markActive(codexHome, registry, parsed.accountKey, parsed);
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

    if (changed) {
      match.last_used_at = nowSeconds();
    }
    const savedTokens = await persistCurrentOAuthSnapshot(codexHome, registry);
    return changed || folded.size > 0 ? save() : savedTokens;
  } finally {
    await releaseLock();
  }
}

// `cx sessions <alias>` would read these as its own actions.
const RESERVED_ALIASES = new Set(["assign", "delete"]);

/** @param {string | undefined} alias */
function assertAliasAllowed(alias) {
  if (alias !== undefined && RESERVED_ALIASES.has(alias)) {
    throw new Error(`"${alias}" can't be an alias: cx sessions ${alias} is a command. Pick another alias.`);
  }
}

/**
 * Registers what ~/.codex holds now (auth.json and config.toml) as an account.
 * @param {string} codexHome
 * @param {string} [alias]
 * @returns {Promise<AccountSummary>}
 */
export async function addAccount(codexHome, alias) {
  assertAliasAllowed(alias);
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

  // Adding is deliberate: this login replaces the same person's other sign-in.
  return withLock(codexHome, "add", () => registerAccount(codexHome, { parsed, alias, provider, authText, configText }, { replaces: true }));
}

/**
 * Writes the snapshots and the registry entry. When the same person is
 * registered under another sign-in, one account remains: this login with
 * `replaces`, otherwise the one with the newer tokens (foldDuplicateLogins).
 * Callers must hold the cx lock.
 * @param {string} codexHome
 * @param {{ parsed: AuthIdentity | null, alias?: string, provider: string | null, authText: string | null, configText: string | null }} login
 * @param {{ replaces?: boolean }} [options]
 * @returns {Promise<AccountSummary>}
 */
async function registerAccount(codexHome, { parsed, alias, provider, authText, configText }, { replaces = false } = {}) {
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

  // Before the activation, so that it credits the recent threads to the
  // account that remains.
  const folded = await foldDuplicateLogins(codexHome, registry, replaces ? accountKey : null);
  const keptKey = folded.get(accountKey) ?? accountKey;
  const kept = /** @type {Account} */ (registry.accounts.find((account) => account.account_key === keptKey));
  if (alias !== undefined) {
    kept.alias = alias;
  }

  await markActive(codexHome, registry, keptKey, parsed);
  await writeRegistry(codexHome, registry);
  await deleteSnapshots(codexHome, folded.keys());

  return { accountKey: keptKey, email: kept.email, alias: kept.alias, provider: kept.provider };
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
  // Before the sign-in, not after it, when addAccount would reject it.
  assertAliasAllowed(alias);
  const authPath = codexPaths(codexHome).auth;
  const previousAuthText = await readTextIfExists(authPath);
  const previous = parseAuthText(previousAuthText);
  const { removed_account_key: removedAccountKey } = await readRegistry(codexHome);
  const saveCurrent = previous !== null && previous.accountKey !== removedAccountKey;
  onCurrentSaved?.(saveCurrent ? await addAccount(codexHome) : null);

  // The sign-in replaces the login, after which nothing tells whose the
  // threads used until now are. Saving the current account above credited
  // them already, but an API key or a removed account isn't saved there. A
  // background cx warm may hold the lock for a moment: wait for it.
  await withLockWhenFree(codexHome, "add", async () => {
    const outgoingLogin = liveLoginOf(previousAuthText, await readTextIfExists(codexPaths(codexHome).config));
    await tryRecordSessionOwners(codexHome, await readRegistry(codexHome), { liveLogin: outgoingLogin });
  });

  // What was registered before the sign-in: a background cx may save the new
  // login before this add does.
  const known = await registeredLogins(codexHome);
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

  const newAuthText = await readTextIfExists(authPath);
  const newIdentity = loginIdentityOf(newAuthText);
  const alreadyRegistered = known.keys.has(parseAuthText(newAuthText)?.accountKey ?? "")
    || (newIdentity !== null && known.identities.has(newIdentity));
  return { ...await addAccount(codexHome, alias), alreadyRegistered };
}

/**
 * A login that never reached the registry, such as one from an interrupted
 * `cx add` or one Codex signed in to on its own, has no snapshot: replacing
 * auth.json would lose it. A login removed with `cx remove` is left out.
 * Callers hold the cx lock.
 * @param {string} codexHome
 * @returns {Promise<boolean>} whether it was registered
 */
async function registerLiveLogin(codexHome) {
  const paths = codexPaths(codexHome);
  const authText = await readTextIfExists(paths.auth);
  const configText = await readTextIfExists(paths.config);
  const parsed = liveLoginOf(authText, configText);
  if (!parsed) {
    return false;
  }

  const { accounts, removed_account_key: removedAccountKey } = await readRegistry(codexHome);
  if (parsed.accountKey === removedAccountKey || accounts.some((account) => account.account_key === parsed.accountKey)) {
    return false;
  }
  await registerAccount(codexHome, { parsed, provider: providerOf(configText), authText, configText });
  return true;
}

/**
 * Makes a registered account the live one: its auth.json, and its provider and
 * model settings merged into the live config.toml. Callers must hold the cx
 * lock (runSwitch does).
 *
 * With `signIn`, its saved login is known to be dead: auth.json is removed
 * instead, so that Codex starts its own sign-in rather than failing to refresh
 * the dead tokens, and the next cx run saves the new login
 * (syncActiveAccountFromCurrentAuth). The snapshot is kept.
 * @param {string} codexHome
 * @param {string} identifier
 * @param {{ signIn?: boolean }} [options]
 * @returns {Promise<AccountSummary>}
 */
export async function useAccount(codexHome, identifier, { signIn = false } = {}) {
  if (!identifier) {
    throw new Error("Missing account identifier. Provide an email, alias, or account key.");
  }

  if (await hasUnsavedNonOAuthLogin(codexHome)) {
    throw new Error("The current login (an API key or other non-ChatGPT login) is not saved and switching would replace it. Save it first: cx add <alias>");
  }
  await registerLiveLogin(codexHome);
  const registry = await readRegistry(codexHome);
  const match = findSingleAccount(registry.accounts, identifier);
  const paths = codexPaths(codexHome);
  const outgoingLogin = liveLoginOf(await readTextIfExists(paths.auth), await readTextIfExists(paths.config));

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

  if (hasAuthSnapshot && !signIn) {
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
  await markActive(codexHome, registry, match.account_key, outgoingLogin);
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
