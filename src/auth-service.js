import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ACCOUNTS_DIR_NAME,
  AUTH_FILE_NAME,
  DEFAULT_PROVIDER,
  REGISTRY_FILE_NAME,
  REGISTRY_SCHEMA_VERSION,
} from "./constants.js";
import { mergeAccountConfigText, readCurrentProviderFromConfigText } from "./config-file.js";
import { LOCK_BUSY_CODE, acquireLock } from "./locking.js";

const AUTH_SNAPSHOT_SUFFIX = ".auth.json";
const CONFIG_SNAPSHOT_SUFFIX = ".config.toml";

export function resolveAccountsDir(codexHome) {
  return path.join(codexHome, ACCOUNTS_DIR_NAME);
}

export function resolveAuthPath(codexHome) {
  return path.join(codexHome, AUTH_FILE_NAME);
}

export function resolveConfigPath(codexHome) {
  return path.join(codexHome, "config.toml");
}

function registryPath(codexHome) {
  return path.join(resolveAccountsDir(codexHome), REGISTRY_FILE_NAME);
}

function emptyRegistry() {
  return {
    schema_version: REGISTRY_SCHEMA_VERSION,
    active_account_key: null,
    active_account_activated_at_ms: null,
    auto_switch: {
      enabled: false,
      threshold_5h_percent: 10,
      threshold_weekly_percent: 5
    },
    api: { usage: false, account: false },
    accounts: []
  };
}

export async function readRegistry(codexHome) {
  const filePath = registryPath(codexHome);
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    if (typeof data === "object" && data !== null && Array.isArray(data.accounts)) {
      return data;
    }
    return emptyRegistry();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyRegistry();
    }
    throw error;
  }
}

async function ensureAccountsDir(codexHome) {
  const dir = resolveAccountsDir(codexHome);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function writeRegistry(codexHome, registry) {
  await ensureAccountsDir(codexHome);
  await writeFileAtomically(registryPath(codexHome), JSON.stringify(registry, null, 2));
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function parseAuthFile(authData) {
  if (!authData?.tokens) {
    return null;
  }
  // An API-key login may still carry tokens from an earlier ChatGPT login;
  // those do not identify the account that is actually in use.
  if (String(authData.auth_mode ?? "").toLowerCase() === "apikey") {
    return null;
  }
  const { tokens } = authData;
  const accountId = tokens.account_id;
  if (!accountId) {
    return null;
  }

  const idTokenClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  const accessTokenClaims = !idTokenClaims && tokens.access_token ? decodeJwtPayload(tokens.access_token) : null;

  let userId = null;
  if (tokens.id_token) {
    userId = idTokenClaims?.sub ?? null;
  }
  if (!userId && tokens.access_token) {
    userId = accessTokenClaims?.sub ?? null;
  }
  if (!userId) {
    return null;
  }

  const accountKey = `${userId}::${accountId}`;

  const email = idTokenClaims?.email ?? null;

  return {
    accountKey,
    userId,
    accountId,
    email,
    authMode: authData.auth_mode ?? "chatgpt"
  };
}

// auth.json that is not in the OpenAI OAuth format is fine for third-party logins.
function parseAuthText(authText) {
  if (authText === null) {
    return null;
  }
  try {
    return parseAuthFile(JSON.parse(authText));
  } catch {
    return null;
  }
}

// Snapshot names use base64url so a key can never produce a "/" in the name.
function encodeAccountKey(accountKey) {
  return Buffer.from(accountKey, "utf8").toString("base64url");
}

export function accountKeyToFilename(accountKey) {
  return `${encodeAccountKey(accountKey)}${AUTH_SNAPSHOT_SUFFIX}`;
}

export function accountKeyToConfigFilename(accountKey) {
  return `${encodeAccountKey(accountKey)}${CONFIG_SNAPSHOT_SUFFIX}`;
}

export function filenameToAccountKey(filename) {
  const match = filename.match(/^(.+)\.auth\.json$/);
  if (!match) {
    return null;
  }
  try {
    // Node's base64 decoder accepts both the standard and the url-safe alphabet.
    return Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileModeOr(filePath, fallbackMode) {
  try {
    return (await fs.stat(filePath)).mode & 0o777;
  } catch {
    return fallbackMode;
  }
}

export async function writeFileAtomically(filePath, text, { mode = 0o600 } = {}) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, text, { encoding: "utf8", mode });
    await fs.chmod(temporaryPath, mode);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function snapshotPaths(codexHome, accountKey) {
  const accountsDir = resolveAccountsDir(codexHome);
  return {
    auth: path.join(accountsDir, accountKeyToFilename(accountKey)),
    config: path.join(accountsDir, accountKeyToConfigFilename(accountKey))
  };
}

async function withRegistryLock(codexHome, label, fn) {
  const releaseLock = await acquireLock(codexHome, label);
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

async function persistCurrentOAuthSnapshot(codexHome, registry) {
  const authPath = resolveAuthPath(codexHome);
  let authText;
  let parsed;

  try {
    authText = await fs.readFile(authPath, "utf8");
    parsed = parseAuthFile(JSON.parse(authText));
  } catch {
    return false;
  }

  if (!parsed?.accountKey) {
    return false;
  }

  const currentAccount = registry.accounts.find(
    (account) => account.account_key === parsed.accountKey
  );
  if (!currentAccount) {
    return false;
  }

  await writeFileAtomically(snapshotPaths(codexHome, currentAccount.account_key).auth, authText);
  return true;
}

// Saves the live config.toml back into the active account's snapshot, so model
// or provider settings changed while that account was active survive a switch
// away and back.
async function persistCurrentConfigSnapshot(codexHome, registry) {
  const currentAccount = registry.accounts.find(
    (account) => account.account_key === registry.active_account_key
  );
  if (!currentAccount) {
    return false;
  }

  const snapshotPath = snapshotPaths(codexHome, currentAccount.account_key).config;
  const liveText = await readTextIfExists(resolveConfigPath(codexHome));
  const snapshotText = await readTextIfExists(snapshotPath);
  if (liveText === null || snapshotText === null) {
    return false;
  }

  // A config that was pointed at another provider by hand does not belong to
  // this account; never overwrite the account's snapshot with it.
  if (readCurrentProviderFromConfigText(liveText).provider !== readCurrentProviderFromConfigText(snapshotText).provider) {
    return false;
  }

  await writeFileAtomically(snapshotPath, liveText);
  return true;
}

async function readProviderFromConfig(codexHome) {
  const configPath = resolveConfigPath(codexHome);
  try {
    const text = await fs.readFile(configPath, "utf8");
    return readCurrentProviderFromConfigText(text).provider;
  } catch {
    return null;
  }
}

function exactAccountMatch(account, identifier, needle) {
  return account.account_key === identifier
    || account.email?.toLowerCase() === needle
    || account.alias?.toLowerCase() === needle;
}

function fuzzyAccountMatch(account, needle) {
  return account.email?.toLowerCase().includes(needle)
    || account.alias?.toLowerCase().includes(needle);
}

export function isExactAccountMatch(account, identifier) {
  return Boolean(identifier) && exactAccountMatch(account, identifier, identifier.toLowerCase());
}

export function findAccountsByIdentifier(accounts, identifier) {
  if (!identifier) {
    return [];
  }

  const needle = identifier.toLowerCase();
  const exactMatches = accounts.filter((account) => exactAccountMatch(account, identifier, needle));
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return accounts.filter((account) => fuzzyAccountMatch(account, needle));
}

export async function listAccounts(codexHome) {
  const registry = await readRegistry(codexHome);
  return registry.accounts;
}

export async function getCurrentAccount(codexHome) {
  const registry = await readRegistry(codexHome);
  if (!registry.active_account_key) {
    return null;
  }
  return registry.accounts.find(
    (account) => account.account_key === registry.active_account_key
  ) ?? null;
}

export async function syncActiveAccountFromCurrentAuth(codexHome) {
  const authPath = resolveAuthPath(codexHome);
  let parsed = null;

  try {
    const authText = await fs.readFile(authPath, "utf8");
    parsed = parseAuthFile(JSON.parse(authText));
  } catch {
    return false;
  }

  if (!parsed?.accountKey) {
    return false;
  }

  // This refresh is opportunistic: if another cx run holds the lock, skip it
  // rather than racing that run's registry write.
  let releaseLock;
  try {
    releaseLock = await acquireLock(codexHome, "sync-active");
  } catch (error) {
    if (error?.code === LOCK_BUSY_CODE) {
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
      registry.active_account_key = parsed.accountKey;
      registry.active_account_activated_at_ms = Date.now();
      changed = true;
    }

    // Only the id_token carries the email; keep the known one when it is absent.
    if (parsed.email && match.email !== parsed.email) {
      match.email = parsed.email;
      changed = true;
    }
    if (match.chatgpt_account_id !== parsed.accountId) {
      match.chatgpt_account_id = parsed.accountId;
      changed = true;
    }
    if (match.chatgpt_user_id !== parsed.userId) {
      match.chatgpt_user_id = parsed.userId;
      changed = true;
    }
    if (match.auth_mode !== parsed.authMode) {
      match.auth_mode = parsed.authMode;
      changed = true;
    }

    if (!changed) {
      return false;
    }

    match.last_used_at = Math.floor(Date.now() / 1000);
    await writeRegistry(codexHome, registry);
    return true;
  } finally {
    await releaseLock();
  }
}

export async function addAccount(codexHome, alias) {
  const authPath = resolveAuthPath(codexHome);
  const configPath = resolveConfigPath(codexHome);

  const authText = await readTextIfExists(authPath);
  const configText = await readTextIfExists(configPath);

  if (authText === null && configText === null) {
    throw new Error(`Neither auth.json nor config.toml found in ${codexHome}. Nothing to add.`);
  }

  const provider = configText === null ? null : readCurrentProviderFromConfigText(configText).provider;

  let parsed = parseAuthText(authText);
  // ChatGPT tokens left in auth.json only identify the account when Codex is
  // actually using the OpenAI provider; otherwise this is a third-party login
  // and must not overwrite the ChatGPT account's registration.
  if (parsed && (provider ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER) {
    parsed = null;
  }

  if (!parsed && !alias) {
    throw new Error(`Cannot auto-detect account identity for provider "${provider ?? DEFAULT_PROVIDER}". Provide an alias: cx add <alias>`);
  }

  return withRegistryLock(codexHome, "add", () => registerAccount(codexHome, {
    parsed,
    alias,
    provider,
    authText,
    configText
  }));
}

// Writes the snapshots and the registry entry. Callers must hold the cx lock.
async function registerAccount(codexHome, { parsed, alias, provider, authText, configText }) {
  const accountKey = parsed ? parsed.accountKey : `manual::${alias}`;
  const email = parsed?.email ?? null;
  const authMode = parsed?.authMode ?? "manual";

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
  const existingIndex = registry.accounts.findIndex(
    (account) => account.account_key === accountKey
  );

  // A ChatGPT login registered from auth.json is the live login now, and adding
  // the removed account back is deliberate: either way the removal is over.
  if (parsed || accountKey === registry.removed_account_key) {
    delete registry.removed_account_key;
  }
  if (parsed || (authText !== null && registry.removed_auth_sha256 === authDigest(authText))) {
    delete registry.removed_auth_sha256;
  }

  const now = Math.floor(Date.now() / 1000);
  const accountEntry = {
    account_key: accountKey,
    chatgpt_account_id: parsed?.accountId ?? null,
    chatgpt_user_id: parsed?.userId ?? null,
    email,
    alias: alias ?? "",
    account_name: null,
    plan: null,
    auth_mode: authMode,
    provider: provider ?? null,
    created_at: now,
    last_used_at: now,
    last_usage: null,
    last_usage_at: null,
    last_local_rollout: null
  };

  if (existingIndex >= 0) {
    const existing = registry.accounts[existingIndex];
    accountEntry.created_at = existing.created_at ?? now;
    accountEntry.alias = alias ?? existing.alias ?? "";
    accountEntry.email = email ?? existing.email ?? null;
    accountEntry.plan = existing.plan;
    accountEntry.account_name = existing.account_name;
    accountEntry.last_usage = existing.last_usage;
    accountEntry.last_usage_at = existing.last_usage_at;
    accountEntry.last_local_rollout = existing.last_local_rollout;
    registry.accounts[existingIndex] = accountEntry;
  } else {
    registry.accounts.push(accountEntry);
  }

  registry.active_account_key = accountKey;
  registry.active_account_activated_at_ms = Date.now();
  await writeRegistry(codexHome, registry);

  return { accountKey, email: accountEntry.email, alias: accountEntry.alias, provider };
}

// True when the outgoing credentials can be restored later, because an account
// snapshot holds exactly this auth.json.
async function isAuthSnapshotted(codexHome, authText) {
  const accountsDir = resolveAccountsDir(codexHome);
  let entries;
  try {
    entries = await fs.readdir(accountsDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
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

// Identifies a non-OAuth login (which has no account key) without storing the
// API key itself in the registry.
function authDigest(authText) {
  return createHash("sha256").update(authText).digest("hex");
}

// An API key or other non-OAuth login of the OpenAI provider exists only in
// auth.json until a snapshot holds it, so replacing auth.json would lose it.
// A login whose account was removed with `cx remove` was given up on purpose.
async function hasUnsavedNonOAuthLogin(codexHome) {
  if ((await readProviderFromConfig(codexHome) ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER) {
    return false;
  }
  const authText = await readTextIfExists(resolveAuthPath(codexHome));
  if (authText === null || parseAuthText(authText) !== null) {
    return false;
  }
  if ((await readRegistry(codexHome)).removed_auth_sha256 === authDigest(authText)) {
    return false;
  }
  return !await isAuthSnapshotted(codexHome, authText);
}

// Third-party accounts and API keys have no browser login: what is in ~/.codex
// is the account, so adding one snapshots it. An unsaved login of that kind must
// be added before signing in, because the sign-in would replace it.
export async function addNeedsLogin(codexHome) {
  if ((await readProviderFromConfig(codexHome) ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER) {
    return false;
  }
  return !await hasUnsavedNonOAuthLogin(codexHome);
}

// Saves the current login, then removes auth.json so Codex starts its own
// sign-in. Removing the file matters: `codex login` and `codex logout` revoke
// any tokens they find, which would invalidate the snapshot just saved.
export async function addAccountWithLogin(codexHome, alias, { runCodex, onCurrentSaved }) {
  const authPath = resolveAuthPath(codexHome);
  const previousAuthText = await readTextIfExists(authPath);
  const previous = parseAuthText(previousAuthText);
  const { removed_account_key: removedAccountKey } = await readRegistry(codexHome);
  const saveCurrent = previous !== null && previous.accountKey !== removedAccountKey;
  onCurrentSaved?.(saveCurrent ? await addAccount(codexHome) : null);

  await fs.rm(authPath, { force: true });

  // Codex stays open after signing in, so its exit code says nothing about the
  // login; what it left in ~/.codex does.
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

// A login that never reached the registry, such as one from an interrupted
// `cx add`, has no snapshot: replacing auth.json would lose it. A login removed
// with `cx remove` is left out.
async function registerLiveLogin(codexHome) {
  const authText = await readTextIfExists(resolveAuthPath(codexHome));
  const configText = await readTextIfExists(resolveConfigPath(codexHome));
  const provider = configText === null ? null : readCurrentProviderFromConfigText(configText).provider;
  const parsed = (provider ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER ? parseAuthText(authText) : null;
  if (!parsed) {
    return;
  }

  const { accounts, removed_account_key: removedAccountKey } = await readRegistry(codexHome);
  if (parsed.accountKey !== removedAccountKey
    && !accounts.some((account) => account.account_key === parsed.accountKey)) {
    await registerAccount(codexHome, { parsed, provider, authText, configText });
  }
}

// Callers must hold the cx lock (runSwitch does).
export async function useAccount(codexHome, identifier) {
  if (!identifier) {
    throw new Error("Missing account identifier. Provide an email, alias, or account key.");
  }

  if (await hasUnsavedNonOAuthLogin(codexHome)) {
    throw new Error("The current login (an API key or other non-ChatGPT login) is not saved and switching would replace it. Save it first: cx add <alias>");
  }
  await registerLiveLogin(codexHome);
  const registry = await readRegistry(codexHome);
  const matches = findAccountsByIdentifier(registry.accounts, identifier);
  const match = matches[0];

  if (!match) {
    throw new Error(`No registered account matches "${identifier}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple registered accounts match "${identifier}".`);
  }

  const paths = snapshotPaths(codexHome, match.account_key);
  const hasAuthSnapshot = await fileExists(paths.auth);
  const hasConfigSnapshot = await fileExists(paths.config);

  if (!hasAuthSnapshot && !hasConfigSnapshot) {
    throw new Error(`No snapshot files found for "${match.email ?? match.alias ?? match.account_key}". Re-add the account.`);
  }

  // Codex refreshes OAuth tokens in auth.json while it is running. Preserve
  // that latest credential set before replacing auth.json with another
  // account, otherwise a later switch restores the stale tokens captured by the
  // original `cx add`. The same applies to the outgoing account's model and
  // provider settings in config.toml.
  await persistCurrentOAuthSnapshot(codexHome, registry);
  await persistCurrentConfigSnapshot(codexHome, registry);

  const authPath = resolveAuthPath(codexHome);
  const configPath = resolveConfigPath(codexHome);

  if (hasAuthSnapshot) {
    await writeFileAtomically(authPath, await fs.readFile(paths.auth, "utf8"));
  } else {
    await fs.rm(authPath, { force: true });
  }

  if (hasConfigSnapshot) {
    // Only provider/model settings are per account. Projects, MCP servers and
    // other settings added since the snapshot was taken stay as they are.
    const snapshotText = await fs.readFile(paths.config, "utf8");
    const liveText = await readTextIfExists(configPath);
    await writeFileAtomically(
      configPath,
      liveText === null ? snapshotText : mergeAccountConfigText(liveText, snapshotText),
      { mode: await fileModeOr(configPath, 0o600) }
    );
  }

  match.provider = (await readProviderFromConfig(codexHome)) ?? match.provider;
  match.last_used_at = Math.floor(Date.now() / 1000);
  registry.active_account_key = match.account_key;
  registry.active_account_activated_at_ms = Date.now();
  // auth.json no longer holds the removed account's login.
  delete registry.removed_account_key;
  delete registry.removed_auth_sha256;
  await writeRegistry(codexHome, registry);

  return {
    accountKey: match.account_key,
    email: match.email,
    alias: match.alias,
    provider: match.provider
  };
}

export async function removeAccount(codexHome, identifier) {
  if (!identifier) {
    throw new Error("Missing account identifier.");
  }

  return withRegistryLock(codexHome, "remove", async () => {
    const registry = await readRegistry(codexHome);
    const matches = findAccountsByIdentifier(registry.accounts, identifier);
    const match = matches[0];

    if (!match) {
      throw new Error(`No registered account matches "${identifier}".`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple registered accounts match "${identifier}".`);
    }

    const index = registry.accounts.findIndex((account) => account.account_key === match.account_key);
    const removed = registry.accounts.splice(index, 1)[0];

    const paths = snapshotPaths(codexHome, removed.account_key);
    const removedAuthText = await readTextIfExists(paths.auth);
    await fs.rm(paths.auth, { force: true });
    await fs.rm(paths.config, { force: true });

    // Codex may still be logged in to the removed account. Remember it, so that
    // neither `cx switch` nor `cx add` registers that login again on its own.
    const liveAuthText = await readTextIfExists(resolveAuthPath(codexHome));
    const live = parseAuthText(liveAuthText);
    if (live?.accountKey === removed.account_key) {
      registry.removed_account_key = removed.account_key;
    }
    // An API key has no account key; remember it by digest, so that it no longer
    // counts as an unsaved login that blocks `cx switch` and `cx add`.
    if (!live && liveAuthText !== null && liveAuthText === removedAuthText) {
      registry.removed_auth_sha256 = authDigest(liveAuthText);
    }

    if (registry.active_account_key === removed.account_key || live?.accountKey === removed.account_key) {
      registry.active_account_key = null;
      registry.active_account_activated_at_ms = null;
    }

    await writeRegistry(codexHome, registry);
    return { accountKey: removed.account_key, email: removed.email };
  });
}
