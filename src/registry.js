import fs from "node:fs/promises";
import path from "node:path";

import { REGISTRY_SCHEMA_VERSION, codexPaths } from "./constants.js";
import { isNotFound, writeFileAtomically } from "./fs-utils.js";

// accounts/registry.json and the per-account snapshots next to it. Existing
// homes already hold this layout (schema 3, base64url snapshot names), so keep
// it and every field, including the auto_switch/api/usage ones cx itself never
// reads.

export const AUTH_SNAPSHOT_SUFFIX = ".auth.json";
const CONFIG_SNAPSHOT_SUFFIX = ".config.toml";

/**
 * @typedef {object} Account
 * @property {string} account_key
 * @property {string | null} chatgpt_account_id
 * @property {string | null} chatgpt_user_id
 * @property {string | null} email
 * @property {string} alias empty when unset
 * @property {string | null} account_name
 * @property {string | null} plan
 * @property {string} auth_mode
 * @property {string | null} provider
 * @property {number} created_at seconds
 * @property {number} last_used_at seconds
 * @property {unknown} last_usage
 * @property {number | null} last_usage_at
 * @property {unknown} last_local_rollout
 */

/**
 * @typedef {object} Registry
 * @property {number} schema_version
 * @property {string | null} active_account_key
 * @property {number | null} active_account_activated_at_ms
 * @property {{ enabled: boolean, threshold_5h_percent: number, threshold_weekly_percent: number }} auto_switch
 * @property {{ usage: boolean, account: boolean }} api
 * @property {Account[]} accounts
 * @property {string} [removed_account_key] the removed account Codex may still be signed in to
 * @property {string} [removed_auth_sha256] digest of a removed API-key login still in auth.json
 */

/** @returns {Registry} */
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

/**
 * @param {string} codexHome
 * @returns {Promise<Registry>}
 */
export async function readRegistry(codexHome) {
  try {
    const data = JSON.parse(await fs.readFile(codexPaths(codexHome).registry, "utf8"));
    return typeof data === "object" && data !== null && Array.isArray(data.accounts) ? data : emptyRegistry();
  } catch (error) {
    if (isNotFound(error)) {
      return emptyRegistry();
    }
    throw error;
  }
}

/** @param {string} codexHome */
export async function ensureAccountsDir(codexHome) {
  await fs.mkdir(codexPaths(codexHome).accounts, { recursive: true, mode: 0o700 });
}

/**
 * @param {string} codexHome
 * @param {Registry} registry
 */
export async function writeRegistry(codexHome, registry) {
  await ensureAccountsDir(codexHome);
  await writeFileAtomically(codexPaths(codexHome).registry, JSON.stringify(registry, null, 2));
}

/**
 * Snapshot names use base64url so a key can never produce a "/" in the name.
 * @param {string} accountKey
 */
function encodeAccountKey(accountKey) {
  return Buffer.from(accountKey, "utf8").toString("base64url");
}

/** @param {string} accountKey */
export function accountKeyToFilename(accountKey) {
  return `${encodeAccountKey(accountKey)}${AUTH_SNAPSHOT_SUFFIX}`;
}

/** @param {string} accountKey */
export function accountKeyToConfigFilename(accountKey) {
  return `${encodeAccountKey(accountKey)}${CONFIG_SNAPSHOT_SUFFIX}`;
}

/**
 * @param {string} codexHome
 * @param {string} accountKey
 */
export function snapshotPaths(codexHome, accountKey) {
  const { accounts } = codexPaths(codexHome);
  return {
    auth: path.join(accounts, accountKeyToFilename(accountKey)),
    config: path.join(accounts, accountKeyToConfigFilename(accountKey))
  };
}

/**
 * @param {Account} account
 * @param {string} identifier
 * @param {string} needle lowercased identifier
 */
function exactAccountMatch(account, identifier, needle) {
  return account.account_key === identifier
    || account.email?.toLowerCase() === needle
    || account.alias?.toLowerCase() === needle;
}

/**
 * @param {Account} account
 * @param {string} identifier
 */
export function isExactAccountMatch(account, identifier) {
  return Boolean(identifier) && exactAccountMatch(account, identifier, identifier.toLowerCase());
}

/**
 * Exact matches on key, email or alias win; otherwise any email or alias that
 * contains the identifier.
 * @param {Account[]} accounts
 * @param {string | undefined} identifier
 */
export function findAccountsByIdentifier(accounts, identifier) {
  if (!identifier) {
    return [];
  }
  const needle = identifier.toLowerCase();
  const exactMatches = accounts.filter((account) => exactAccountMatch(account, identifier, needle));
  if (exactMatches.length > 0) {
    return exactMatches;
  }
  return accounts.filter((account) => account.email?.toLowerCase().includes(needle)
    || account.alias?.toLowerCase().includes(needle));
}

/**
 * The one account an identifier names, or an error saying why there is none.
 * @param {Account[]} accounts
 * @param {string} identifier
 */
export function findSingleAccount(accounts, identifier) {
  const matches = findAccountsByIdentifier(accounts, identifier);
  if (!matches.length) {
    throw new Error(`No registered account matches "${identifier}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple registered accounts match "${identifier}".`);
  }
  return matches[0];
}

/**
 * An unset alias is an empty string, and a login without an id_token has no email.
 * @param {Pick<Account, "email" | "alias" | "account_key">} account
 */
export function accountDisplayName(account) {
  return account.email || account.alias || account.account_key;
}

/** @param {string} codexHome */
export async function listAccounts(codexHome) {
  return (await readRegistry(codexHome)).accounts;
}

/** @param {string} codexHome */
export async function getCurrentAccount(codexHome) {
  const registry = await readRegistry(codexHome);
  if (!registry.active_account_key) {
    return null;
  }
  return registry.accounts.find((account) => account.account_key === registry.active_account_key) ?? null;
}
