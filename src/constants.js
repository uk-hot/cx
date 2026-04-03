import os from "node:os";
import path from "node:path";

export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_LOCK_NAME = "provider-sync.lock";
export const DB_FILE_BASENAME = "state_5.sqlite";
export const SESSION_DIRS = ["sessions", "archived_sessions"];

export function defaultCodexHome() {
  return path.join(os.homedir(), ".codex");
}

export const AUTH_FILE_NAME = "auth.json";
export const ACCOUNTS_DIR_NAME = "accounts";
export const REGISTRY_FILE_NAME = "registry.json";
export const REGISTRY_SCHEMA_VERSION = 3;
