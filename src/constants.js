import os from "node:os";
import path from "node:path";

export const DEFAULT_PROVIDER = "openai";
export const SESSION_DIRS = /** @type {const} */ (["sessions", "archived_sessions"]);
// Codex 0.168+ tags threads with their creator: these columns in the threads
// table, plus account_scoped in the rollout's session_meta only.
export const CREATOR_COLUMNS = ["creator_user_id", "creator_account_id"];
export const ACCOUNT_SCOPE_KEYS = ["account_scoped", ...CREATOR_COLUMNS];
export const REGISTRY_SCHEMA_VERSION = 3;

export function defaultCodexHome() {
  return path.join(os.homedir(), ".codex");
}

/**
 * Every file and directory cx reads or writes inside a Codex home.
 * @param {string} codexHome
 */
export function codexPaths(codexHome) {
  const accounts = path.join(codexHome, "accounts");
  return {
    home: codexHome,
    auth: path.join(codexHome, "auth.json"),
    config: path.join(codexHome, "config.toml"),
    stateDb: path.join(codexHome, "state_5.sqlite"),
    lockDir: path.join(codexHome, "tmp", "provider-sync.lock"),
    // Codex 0.168+ holds <thread id>.lock open (and flocked) while it writes a thread.
    threadWriterLocks: path.join(codexHome, "thread-writer-locks"),
    accounts,
    registry: path.join(accounts, "registry.json")
  };
}
