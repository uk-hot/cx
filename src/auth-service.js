import fs from "node:fs/promises";
import path from "node:path";

import {
  ACCOUNTS_DIR_NAME,
  AUTH_FILE_NAME,
  REGISTRY_FILE_NAME,
  REGISTRY_SCHEMA_VERSION,
} from "./constants.js";
import { readCurrentProviderFromConfigText } from "./config-file.js";

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

export async function writeRegistry(codexHome, registry) {
  const dir = resolveAccountsDir(codexHome);
  await fs.mkdir(dir, { recursive: true });
  const filePath = registryPath(codexHome);
  await fs.writeFile(filePath, JSON.stringify(registry, null, 2), "utf8");
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

export function accountKeyToFilename(accountKey) {
  return `${Buffer.from(accountKey, "utf8").toString("base64").replace(/=+$/, "")}.auth.json`;
}

export function accountKeyToConfigFilename(accountKey) {
  return `${Buffer.from(accountKey, "utf8").toString("base64").replace(/=+$/, "")}.config.toml`;
}

export function filenameToAccountKey(filename) {
  const match = filename.match(/^(.+)\.auth\.json$/);
  if (!match) {
    return null;
  }
  try {
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

  if (match.email !== parsed.email) {
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
}

export async function saveAccount(codexHome, alias) {
  const accountsDir = resolveAccountsDir(codexHome);
  await fs.mkdir(accountsDir, { recursive: true });

  const authPath = resolveAuthPath(codexHome);
  const configPath = resolveConfigPath(codexHome);

  const authExists = await fileExists(authPath);
  const configExists = await fileExists(configPath);

  if (!authExists && !configExists) {
    throw new Error(`Neither auth.json nor config.toml found in ${codexHome}. Nothing to save.`);
  }

  let parsed = null;
  if (authExists) {
    try {
      const authText = await fs.readFile(authPath, "utf8");
      const authData = JSON.parse(authText);
      parsed = parseAuthFile(authData);
    } catch {
      // auth.json exists but is not OpenAI OAuth format — that's fine for third-party
    }
  }

  let accountKey;
  let email = null;
  let authMode = "manual";

  if (parsed) {
    accountKey = parsed.accountKey;
    email = parsed.email;
    authMode = parsed.authMode;
  } else {
    if (!alias) {
      throw new Error("Cannot auto-detect account identity. Provide an alias: cx save <alias>");
    }
    accountKey = `manual::${alias}`;
  }

  if (authExists) {
    const snapshotFilename = accountKeyToFilename(accountKey);
    await fs.copyFile(authPath, path.join(accountsDir, snapshotFilename));
  }

  if (configExists) {
    const configSnapshotFilename = accountKeyToConfigFilename(accountKey);
    await fs.copyFile(configPath, path.join(accountsDir, configSnapshotFilename));
  }

  const provider = await readProviderFromConfig(codexHome);

  const registry = await readRegistry(codexHome);
  const existingIndex = registry.accounts.findIndex(
    (account) => account.account_key === accountKey
  );

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
    accountEntry.plan = existing.plan;
    accountEntry.account_name = existing.account_name;
    accountEntry.last_usage = existing.last_usage;
    accountEntry.last_usage_at = existing.last_usage_at;
    accountEntry.last_local_rollout = existing.last_local_rollout;
    registry.accounts[existingIndex] = accountEntry;
  } else {
    registry.accounts.push(accountEntry);
  }

  if (!registry.active_account_key) {
    registry.active_account_key = accountKey;
    registry.active_account_activated_at_ms = Date.now();
  }
  await writeRegistry(codexHome, registry);

  return { accountKey, email, alias: accountEntry.alias, provider };
}

export async function useAccount(codexHome, identifier) {
  if (!identifier) {
    throw new Error("Missing account identifier. Provide an email, alias, or account key.");
  }

  const registry = await readRegistry(codexHome);
  const matches = findAccountsByIdentifier(registry.accounts, identifier);
  const match = matches[0];

  if (!match) {
    throw new Error(`No saved account matches "${identifier}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple saved accounts match "${identifier}".`);
  }

  const accountsDir = resolveAccountsDir(codexHome);

  const authSnapshotPath = path.join(accountsDir, accountKeyToFilename(match.account_key));
  const configSnapshotPath = path.join(accountsDir, accountKeyToConfigFilename(match.account_key));

  const hasAuthSnapshot = await fileExists(authSnapshotPath);
  const hasConfigSnapshot = await fileExists(configSnapshotPath);

  if (!hasAuthSnapshot && !hasConfigSnapshot) {
    throw new Error(`No snapshot files found for "${match.email ?? match.alias ?? match.account_key}". Re-save the account.`);
  }

  const authPath = resolveAuthPath(codexHome);
  const configPath = resolveConfigPath(codexHome);

  if (hasAuthSnapshot) {
    await fs.rm(authPath, { force: true });
    await fs.copyFile(authSnapshotPath, authPath);
  } else {
    await fs.rm(authPath, { force: true });
  }

  if (hasConfigSnapshot) {
    await fs.copyFile(configSnapshotPath, configPath);
  }

  match.last_used_at = Math.floor(Date.now() / 1000);
  registry.active_account_key = match.account_key;
  registry.active_account_activated_at_ms = Date.now();
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

  const registry = await readRegistry(codexHome);
  const matches = findAccountsByIdentifier(registry.accounts, identifier);
  const match = matches[0];

  if (!match) {
    throw new Error(`No saved account matches "${identifier}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple saved accounts match "${identifier}".`);
  }

  const index = registry.accounts.findIndex((account) => account.account_key === match.account_key);
  const removed = registry.accounts.splice(index, 1)[0];

  const accountsDir = resolveAccountsDir(codexHome);
  await fs.rm(path.join(accountsDir, accountKeyToFilename(removed.account_key)), { force: true });
  await fs.rm(path.join(accountsDir, accountKeyToConfigFilename(removed.account_key)), { force: true });

  if (registry.active_account_key === removed.account_key) {
    registry.active_account_key = null;
    registry.active_account_activated_at_ms = null;
  }

  await writeRegistry(codexHome, registry);
  return { accountKey: removed.account_key, email: removed.email };
}
