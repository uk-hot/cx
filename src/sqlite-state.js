import fs from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";

import { CREATOR_COLUMNS, codexPaths } from "./constants.js";

// How long a statement waits for a running Codex to release the database.
const BUSY_TIMEOUT_MS = 5000;
const require = createRequire(import.meta.url);

/** @type {typeof import("node:sqlite").DatabaseSync | undefined} */
let DatabaseSync;

// node:sqlite is built into Node 22.13+ and 23.4+ (23.0-23.3 still hide it
// behind --experimental-sqlite) and needs no native addon, but it
// still prints an ExperimentalWarning when first loaded. Load it lazily and
// drop only that warning so cx output stays clean.
export function loadDatabaseSync() {
  if (DatabaseSync) {
    return DatabaseSync;
  }
  /** @type {typeof import("node:sqlite").DatabaseSync} */
  let loaded;
  const originalEmitWarning = process.emitWarning;
  /** @type {(warning: string | Error, ...args: any[]) => void} */
  const filtered = function emitWarning(warning, ...args) {
    const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
    const message = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && /sqlite/i.test(message ?? "")) {
      return;
    }
    return originalEmitWarning.call(process, warning, ...args);
  };
  process.emitWarning = filtered;
  try {
    ({ DatabaseSync: loaded } = require("node:sqlite"));
  } catch (error) {
    throw new Error(`cx needs Node.js 22.13+ or 23.4+ for the built-in node:sqlite module (running ${process.version}).`, { cause: error });
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  DatabaseSync = loaded;
  return loaded;
}

/** @param {string} dbPath */
function openDatabase(dbPath) {
  const Database = loadDatabaseSync();
  return new Database(dbPath);
}

// SQLITE_BUSY (5) and SQLITE_LOCKED (6), with or without extended codes.
/** @param {unknown} error */
function isSqliteBusyError(error) {
  const errcode = /** @type {{ errcode?: number }} */ (error)?.errcode;
  return typeof errcode === "number" && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6);
}

/**
 * @param {unknown} error
 * @param {string} action
 */
function wrapSqliteBusyError(error, action) {
  if (!isSqliteBusyError(error)) {
    return error;
  }
  return new Error(
    `Unable to ${action} because state_5.sqlite is currently in use. Close Codex and the Codex app, then retry.`,
    { cause: error }
  );
}

/**
 * The state database, or null when Codex has not created one.
 * @param {string} codexHome
 */
async function openStateDatabase(codexHome) {
  const dbPath = codexPaths(codexHome).stateDb;
  try {
    await fs.access(dbPath);
  } catch {
    return null;
  }
  const db = openDatabase(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/** @param {string} codexHome */
export async function readSqliteProviderCounts(codexHome) {
  const db = await openStateDatabase(codexHome);
  if (!db) {
    return null;
  }
  try {
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN model_provider IS NULL OR model_provider = '' THEN '(missing)'
          ELSE model_provider
        END AS model_provider,
        archived,
        COUNT(*) AS count
      FROM threads
      GROUP BY model_provider, archived
      ORDER BY archived, model_provider
    `).all();
    /** @type {{ sessions: Record<string, number>, archived_sessions: Record<string, number> }} */
    const result = {
      sessions: {},
      archived_sessions: {}
    };
    for (const row of rows) {
      const bucket = row.archived ? result.archived_sessions : result.sessions;
      bucket[String(row.model_provider)] = Number(row.count);
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * @typedef {object} ThreadRow
 * @property {string} id
 * @property {string | null} rolloutPath
 * @property {string} title the thread's name, title or preview, whichever is set
 * @property {string | null} cwd
 * @property {number | null} createdAtMs
 * @property {number | null} updatedAtMs no earlier than the thread's last update
 * @property {boolean} archived
 * @property {string | null} creatorUserId Codex 0.168+ creator tag, until cx sync clears it
 * @property {string | null} creatorAccountId
 */

/**
 * Every thread in the state database, or null without one. Columns Codex
 * added over time are read only when they exist.
 * @param {string} codexHome
 * @returns {Promise<ThreadRow[] | null>}
 */
export async function readThreadRows(codexHome) {
  const db = await openStateDatabase(codexHome);
  if (!db) {
    return null;
  }
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => String(column.name)));
    /** @param {string} column @param {string} [fallback] */
    const col = (column, fallback = "NULL") => (columns.has(column) ? column : fallback);
    /** @param {string} column */
    const text = (column) => (columns.has(column) ? `NULLIF(${column}, '')` : "NULL");
    // A whole-second column is read as the last millisecond of its second for
    // updated_at, which callers use as "not before", and as the first for
    // created_at.
    /** @param {string} msColumn @param {string} secondsColumn @param {number} [roundUp] */
    const ms = (msColumn, secondsColumn, roundUp = 0) => `COALESCE(${col(msColumn)}, ${columns.has(secondsColumn) ? `${secondsColumn} * 1000 + ${roundUp}` : "NULL"})`;
    const rows = db.prepare(`
      SELECT
        id,
        ${col("rollout_path")} AS rollout_path,
        COALESCE(${["name", "title", "preview", "first_user_message"].map(text).join(", ")}, '') AS title,
        ${col("cwd")} AS cwd,
        ${ms("created_at_ms", "created_at")} AS created_at_ms,
        ${ms("updated_at_ms", "updated_at", 999)} AS updated_at_ms,
        ${col("archived", "0")} AS archived,
        ${col("creator_user_id")} AS creator_user_id,
        ${col("creator_account_id")} AS creator_account_id
      FROM threads
    `).all();
    return rows.map((row) => ({
      id: String(row.id),
      rolloutPath: row.rollout_path === null ? null : String(row.rollout_path),
      title: String(row.title),
      cwd: row.cwd === null ? null : String(row.cwd),
      createdAtMs: row.created_at_ms === null ? null : Number(row.created_at_ms),
      updatedAtMs: row.updated_at_ms === null ? null : Number(row.updated_at_ms),
      archived: Boolean(row.archived),
      creatorUserId: row.creator_user_id === null ? null : String(row.creator_user_id),
      creatorAccountId: row.creator_account_id === null ? null : String(row.creator_account_id)
    }));
  } finally {
    db.close();
  }
}

/**
 * Which of `ids` the state database still has.
 * @param {string} codexHome
 * @param {string[]} ids
 * @returns {Promise<Set<string>>}
 */
export async function readPresentThreadIds(codexHome, ids) {
  const db = await openStateDatabase(codexHome);
  if (!db || ids.length === 0) {
    db?.close();
    return new Set();
  }
  try {
    return new Set(db.prepare("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids))
      .map((row) => String(row.id)));
  } finally {
    db.close();
  }
}

/**
 * Parent → child links of the sub-agent threads a thread spawned.
 * @param {string} codexHome
 * @returns {Promise<{ parent: string, child: string }[]>}
 */
export async function readThreadSpawnEdges(codexHome) {
  const db = await openStateDatabase(codexHome);
  if (!db) {
    return [];
  }
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'").get();
    if (!table) {
      return [];
    }
    return db.prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all()
      .map((row) => ({ parent: String(row.parent_thread_id), child: String(row.child_thread_id) }));
  } finally {
    db.close();
  }
}

/**
 * The threads Codex extracted a memory from (memories_1.sqlite).
 * @param {string} codexHome
 * @returns {Promise<Set<string>>}
 */
export async function readMemoryThreadIds(codexHome) {
  const dbPath = codexPaths(codexHome).memoriesDb;
  try {
    await fs.access(dbPath);
  } catch {
    return new Set();
  }
  const db = openDatabase(dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage1_outputs'").get();
    if (!table) {
      return new Set();
    }
    return new Set(db.prepare("SELECT thread_id FROM stage1_outputs").all().map((row) => String(row.thread_id)));
  } finally {
    db.close();
  }
}

/**
 * The rollout files of the threads Codex updated last, newest first.
 * @param {string} codexHome
 * @param {number} limit
 * @returns {Promise<string[]>}
 */
export async function readRecentRolloutPaths(codexHome, limit) {
  const db = await openStateDatabase(codexHome);
  if (!db) {
    return [];
  }
  try {
    return db.prepare("SELECT rollout_path FROM threads ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map((row) => String(row.rollout_path));
  } finally {
    db.close();
  }
}

/**
 * Takes and drops the write lock, so a sync fails before touching any file
 * when Codex holds the database.
 * @param {string} codexHome
 */
export async function assertSqliteWritable(codexHome) {
  const db = await openStateDatabase(codexHome);
  if (!db) {
    return { databasePresent: false };
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { databasePresent: true };
  } catch (error) {
    throw wrapSqliteBusyError(error, "update session provider metadata");
  } finally {
    db.close();
  }
}

/**
 * @param {string} codexHome
 * @param {string} targetProvider
 * @param {{ skippedThreadIds: string[], skippedRolloutPaths: string[] }} skipped threads whose rollout was left alone
 */
export async function updateSqliteProvider(codexHome, targetProvider, { skippedThreadIds, skippedRolloutPaths }) {
  const db = await openStateDatabase(codexHome);
  if (!db) {
    return { updatedRows: 0, databasePresent: false };
  }
  let transactionOpen = false;
  try {
    // Clear the creator columns (Codex 0.168+) along with the rollout headers.
    // Codex merges them back with COALESCE(row, rollout), so both must go.
    // Read the schema before taking the write lock to keep the lock short.
    const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
    const creatorColumns = CREATOR_COLUMNS.filter((column) => columns.has(column));
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const assignments = ["model_provider = ?", ...creatorColumns.map((column) => `${column} = NULL`)];
    const pending = ["COALESCE(model_provider, '') <> ?", ...creatorColumns.map((column) => `${column} IS NOT NULL`)];
    // Threads whose rollout file was skipped (locked or changed) keep their
    // provider and creator, so the rollout file and its row stay in agreement.
    const stmt = db.prepare(`
      UPDATE threads
      SET ${assignments.join(", ")}
      WHERE (${pending.join(" OR ")})
        AND id NOT IN (SELECT value FROM json_each(?))
        AND rollout_path NOT IN (SELECT value FROM json_each(?))
    `);
    const result = stmt.run(
      targetProvider,
      targetProvider,
      JSON.stringify(skippedThreadIds),
      JSON.stringify(skippedRolloutPaths)
    );
    db.exec("COMMIT");
    transactionOpen = false;
    return { updatedRows: Number(result.changes), databasePresent: true };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures and surface the original error.
      }
    }
    throw wrapSqliteBusyError(error, "update session provider metadata");
  } finally {
    db.close();
  }
}
