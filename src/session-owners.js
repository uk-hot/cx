import fs from "node:fs/promises";

import { creatorIdsOf } from "./auth-file.js";
import { codexPaths } from "./constants.js";
import { isNotFound, readTextIfExists, writeFileAtomically } from "./fs-utils.js";
import { ensureAccountsDir, snapshotPaths } from "./registry.js";
import { readThreadRows } from "./sqlite-state.js";

/** @typedef {import("./registry.js").Registry} Registry */
/** @typedef {import("./auth-file.js").AuthIdentity} AuthIdentity */
/** @typedef {import("./sqlite-state.js").ThreadRow} ThreadRow */

// cx shares every thread with every account (it clears Codex's creator tags on
// a switch), so Codex itself can no longer say whose a thread is. cx records it
// in accounts/threads.json instead. A thread belongs to the account that used
// it last: the one logged in when its latest turn started. Using another
// account's thread moves it to the account using it.
//
// The account logged in between two activations is known (the registry's
// active account since active_account_activated_at_ms), so each activation
// first credits the threads used since the previous one to the outgoing
// account. That holds only while the login in auth.json is that account's;
// when it isn't (a `codex login` behind cx's back), only Codex's creator tags
// say anything. Tags also win over the window for a thread created in it by
// another login.

/**
 * @typedef {object} ThreadOwner
 * @property {string} account registry account key
 * @property {"activity" | "tag" | "manual"} via how cx learned it
 * @property {number} at ms, when it was recorded
 */

/**
 * @typedef {object} ThreadOwners
 * @property {number} version
 * @property {Record<string, ThreadOwner>} threads by thread id
 * @property {string[]} [pending_cleanup] deleted threads whose prompts and
 *   leftover files are still to be removed (see finishSessionCleanup)
 */

const OWNERS_VERSION = 1;
const READ_CHUNK_BYTES = 256 * 1024;
// Rollout events that start a turn: task_started (current Codex), and
// user_message (each prompt, also in rollouts from before task_started).
const ACTIVITY_TYPES = new Set(["task_started", "user_message"]);
const ACTIVITY_MARKERS = [...ACTIVITY_TYPES].map((type) => Buffer.from(`"${type}"`));

/**
 * @param {string} codexHome
 * @returns {Promise<ThreadOwners>}
 */
export async function readThreadOwners(codexHome) {
  const filePath = codexPaths(codexHome).threadOwners;
  const text = await readTextIfExists(filePath);
  if (text === null) {
    return { version: OWNERS_VERSION, threads: {} };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix it to use cx sessions.`);
  }
  if (typeof data !== "object" || data === null || typeof data.threads !== "object" || data.threads === null) {
    throw new Error(`${filePath} is not a cx thread owner file.`);
  }
  return data;
}

/**
 * @param {string} codexHome
 * @param {ThreadOwners} owners
 */
export async function writeThreadOwners(codexHome, owners) {
  await ensureAccountsDir(codexHome);
  await writeFileAtomically(codexPaths(codexHome).threadOwners, `${JSON.stringify(owners, null, 2)}\n`);
}

/**
 * The time a rollout line starts a turn at, or null for any other line.
 * @param {Buffer} line
 */
function activityAt(line) {
  if (!ACTIVITY_MARKERS.some((marker) => line.includes(marker))) {
    return null;
  }
  try {
    const record = JSON.parse(line.toString("utf8"));
    if (record?.type !== "event_msg" || !ACTIVITY_TYPES.has(record.payload?.type)) {
      return null;
    }
    const at = Date.parse(record.timestamp);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * When the latest turn of a rollout started, or null when it has none. Reads
 * backwards from the end, where that turn usually is.
 * @param {string} filePath
 * @returns {Promise<number | null>}
 */
export async function lastActivityMs(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  try {
    let position = (await handle.stat()).size;
    // The start of a line whose beginning is in a chunk not read yet.
    let pending = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(READ_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      const buffer = pending.length ? Buffer.concat([chunk, pending]) : chunk;
      let end = buffer.length;
      while (end > 0) {
        const newline = buffer.lastIndexOf(0x0a, end - 1);
        if (newline === -1) {
          break;
        }
        const at = activityAt(buffer.subarray(newline + 1, end));
        if (at !== null) {
          return at;
        }
        end = newline;
      }
      pending = buffer.subarray(0, end);
    }
    return activityAt(pending);
  } finally {
    await handle.close();
  }
}

/**
 * Who each registered ChatGPT login tags its threads as, from its snapshot.
 * @param {string} codexHome
 * @param {Registry} registry
 */
async function creatorIndex(codexHome, registry) {
  /** @type {{ accountKey: string, userId: string | null, accountId: string }[]} */
  const index = [];
  for (const account of registry.accounts) {
    const authText = await readTextIfExists(snapshotPaths(codexHome, account.account_key).auth).catch(() => null);
    const ids = creatorIdsOf(authText);
    if (ids) {
      index.push({ accountKey: account.account_key, ...ids });
    }
  }
  return index;
}

/**
 * The registered account a thread's creator tag names, or null.
 * @param {Pick<ThreadRow, "creatorUserId" | "creatorAccountId">} thread
 * @param {Awaited<ReturnType<typeof creatorIndex>>} index
 */
function taggedAccount(thread, index) {
  if (!thread.creatorAccountId) {
    return null;
  }
  // A team workspace is one ChatGPT account for all its members: the account
  // id alone may name several logins.
  const matches = index.filter((entry) => entry.accountId === thread.creatorAccountId
    && (entry.userId === null || thread.creatorUserId === null || entry.userId === thread.creatorUserId));
  const exact = matches.filter((entry) => entry.userId !== null && entry.userId === thread.creatorUserId);
  if (exact.length === 1) {
    return exact[0].accountKey;
  }
  return matches.length === 1 ? matches[0].accountKey : null;
}

/**
 * Whether the account the registry says is active is the one actually logged
 * in, so the threads used since its activation are its own. A third-party
 * provider or API key has no identity in auth.json; only cx switches to those.
 * @param {Registry} registry
 * @param {AuthIdentity | null} liveLogin
 */
function windowIsTrusted(registry, liveLogin) {
  const activeKey = registry.active_account_key;
  if (!activeKey || typeof registry.active_account_activated_at_ms !== "number"
    || !registry.accounts.some((account) => account.account_key === activeKey)) {
    return false;
  }
  return liveLogin ? liveLogin.accountKey === activeKey : activeKey.startsWith("manual::");
}

/**
 * Credits the threads used since the active account was activated to it, and
 * any other thread with a creator tag but no owner to the tagged account.
 * Callers hold the cx lock, and call it before the active account changes.
 * @param {string} codexHome
 * @param {Registry} registry as it is before the change
 * @param {{ liveLogin: AuthIdentity | null }} options the login auth.json holds now
 * @returns {Promise<{ updated: number }>}
 */
export async function recordSessionOwners(codexHome, registry, { liveLogin }) {
  const threads = await readThreadRows(codexHome);
  if (!threads?.length) {
    return { updated: 0 };
  }
  const owners = await readThreadOwners(codexHome);
  const index = await creatorIndex(codexHome, registry);
  const activeKey = /** @type {string} */ (registry.active_account_key);
  const windowStart = /** @type {number} */ (registry.active_account_activated_at_ms);
  const trusted = windowIsTrusted(registry, liveLogin);
  const registered = new Set(registry.accounts.map((account) => account.account_key));
  const now = Date.now();

  let updated = 0;
  for (const thread of threads) {
    const tagged = taggedAccount(thread, index);
    // An owner that is no longer registered counts as none.
    const recorded = owners.threads[thread.id];
    const current = recorded && registered.has(recorded.account) ? recorded : null;
    /** @type {Omit<ThreadOwner, "at"> | null} */
    let next = null;
    if (trusted && thread.rolloutPath && (thread.updatedAtMs === null || thread.updatedAtMs >= windowStart)) {
      // A rollout cx can't read counts as having no turn, rather than failing
      // the record of every other thread.
      const activity = await lastActivityMs(thread.rolloutPath).catch(() => null);
      // Only a turn after the owner was recorded changes it: a turn the
      // current owner was already credited for, or one from before a
      // `cx sessions assign`, doesn't.
      if (activity !== null && activity >= windowStart && activity > (current?.at ?? -Infinity)) {
        const createdInWindow = thread.createdAtMs !== null && thread.createdAtMs >= windowStart;
        next = tagged && createdInWindow && tagged !== activeKey
          ? { account: tagged, via: "tag" }
          : { account: activeKey, via: "activity" };
      }
    }
    if (!next && tagged && !current) {
      next = { account: tagged, via: "tag" };
    }
    if (next && recorded?.account !== next.account) {
      owners.threads[thread.id] = { ...next, at: now };
      updated += 1;
    }
  }
  if (updated > 0) {
    await writeThreadOwners(codexHome, owners);
  }
  return { updated };
}

/**
 * Same as recordSessionOwners, but never fails the command it runs in: the
 * threads stay unrecorded, and the next activation or `cx sessions` retries
 * the tags (the window of a failed activation is lost).
 * @param {string} codexHome
 * @param {Registry} registry
 * @param {{ liveLogin: AuthIdentity | null }} options
 */
export async function tryRecordSessionOwners(codexHome, registry, options) {
  try {
    await recordSessionOwners(codexHome, registry, options);
  } catch (error) {
    console.warn(`Could not record which account the recent Codex sessions belong to: ${error instanceof Error ? error.message : String(error)}`);
  }
}
