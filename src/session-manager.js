import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { liveLoginOf } from "./accounts.js";
import { codexPaths } from "./constants.js";
import { errorMessage, fileExists, isNotFound, readTextIfExists, temporaryPathFor } from "./fs-utils.js";
import { withLockWhenFree } from "./locking.js";
import { DETACHED, killTree } from "./process-tree.js";
import { readRegistry } from "./registry.js";
import { findThreadsInUse } from "./session-files.js";
import { readThreadOwners, recordSessionOwners, writeThreadOwners } from "./session-owners.js";
import { readMemoryThreadIds, readPresentThreadIds, readThreadRows, readThreadSpawnEdges } from "./sqlite-state.js";

/** @typedef {import("./registry.js").Account} Account */
/** @typedef {import("./registry.js").Registry} Registry */
/** @typedef {import("./session-owners.js").ThreadOwner} ThreadOwner */
/** @typedef {import("./sqlite-state.js").ThreadRow} ThreadRow */

/**
 * @typedef {object} SessionEntry
 * @property {ThreadRow} thread
 * @property {ThreadOwner | null} owner null when no registered account owns it
 * @property {boolean} hasMemory Codex extracted a memory from it
 */

/**
 * @typedef {object} SessionView
 * @property {Registry} registry
 * @property {SessionEntry[]} entries newest first
 * @property {{ parent: string, child: string }[]} edges sub-agent threads
 */

const CODEX_COMMAND_TIMEOUT_MS = 60 * 1000;
const MIN_ID_PREFIX = 4;
// history.jsonl is rewritten only when Codex didn't append to it meanwhile.
const HISTORY_ATTEMPTS = 5;
// A Codex that opened history.jsonl just before cx replaced it appends to the
// old file. Codex retries its lock on the file for up to a second before
// writing, so cx keeps copying what lands there until it has been quiet this long.
const HISTORY_SETTLE_MS = 1500;
const HISTORY_SETTLE_MAX_MS = 10 * 1000;
const HISTORY_POLL_MS = 100;
// Sessions deleted per hold of the cx lock: a few seconds of `codex delete`.
const DELETE_BATCH_SIZE = 25;
// Cleanup turns thread ids into file names: an id that isn't a single plain
// path component (a hand-edited threads.json) is never used as one.
const SAFE_THREAD_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Credits the threads used since the active account's activation to it, then
 * reads every thread with its owner. Callers hold the cx lock.
 * @param {string} codexHome
 * @returns {Promise<SessionView>}
 */
async function loadSessionsLocked(codexHome) {
  const registry = await readRegistry(codexHome);
  const paths = codexPaths(codexHome);
  const liveLogin = liveLoginOf(await readTextIfExists(paths.auth), await readTextIfExists(paths.config));
  await recordSessionOwners(codexHome, registry, { liveLogin });

  const [threads, owners, memoryIds, edges] = await Promise.all([
    readThreadRows(codexHome),
    readThreadOwners(codexHome),
    readMemoryThreadIds(codexHome),
    readThreadSpawnEdges(codexHome)
  ]);
  const registered = new Set(registry.accounts.map((account) => account.account_key));
  const entries = (threads ?? []).map((thread) => {
    const owner = owners.threads[thread.id];
    return {
      thread,
      owner: owner && registered.has(owner.account) ? owner : null,
      hasMemory: memoryIds.has(thread.id)
    };
  });
  entries.sort((left, right) => (right.thread.updatedAtMs ?? 0) - (left.thread.updatedAtMs ?? 0));
  return { registry, entries, edges };
}

/**
 * @param {string} codexHome
 * @returns {Promise<SessionView>}
 */
export function loadSessions(codexHome) {
  return withLockWhenFree(codexHome, "sessions", () => loadSessionsLocked(codexHome));
}

/**
 * Thread ids from full ids or unique prefixes.
 * @param {SessionEntry[]} entries
 * @param {string[]} identifiers
 */
export function resolveThreadIds(entries, identifiers) {
  return identifiers.map((identifier) => {
    const needle = identifier.toLowerCase();
    const exact = entries.find((entry) => entry.thread.id.toLowerCase() === needle);
    if (exact) {
      return exact.thread.id;
    }
    if (needle.length < MIN_ID_PREFIX) {
      throw new Error(`Session id "${identifier}" is too short: give at least ${MIN_ID_PREFIX} characters.`);
    }
    const matches = entries.filter((entry) => entry.thread.id.toLowerCase().startsWith(needle));
    if (matches.length === 0) {
      throw new Error(`No session matches "${identifier}".`);
    }
    if (matches.length > 1) {
      throw new Error(`"${identifier}" matches ${matches.length} sessions; give more of the id.`);
    }
    return matches[0].thread.id;
  });
}

/**
 * @typedef {object} DeletionGroup
 * @property {SessionEntry} root deleted with `codex delete`, which deletes the
 *   sub-agent threads it spawned along with it
 * @property {SessionEntry[]} members the root first, then the sub-agent threads under it
 */

/**
 * @typedef {object} DeletionPlan
 * @property {DeletionGroup[]} groups
 * @property {{ id: string, others: string[] }[]} blocked sessions left alone because
 *   sub-agent threads under them have another owner, which `codex delete` would delete too
 * @property {string[]} moved sessions that no longer belong to the selection's owner
 */

/**
 * Groups sessions for `codex delete`, which deletes a thread together with
 * every sub-agent thread under it. A session is deleted only when all of
 * those belong to the same owner as it.
 * @param {SessionView} view
 * @param {string | null} accountKey the owner, null for no registered owner
 * @param {string[]} ids
 * @returns {DeletionPlan}
 */
function planDeletion(view, accountKey, ids) {
  const byId = new Map(view.entries.map((entry) => [entry.thread.id, entry]));
  /** @type {Map<string, string[]>} */
  const childrenOf = new Map();
  for (const { parent, child } of view.edges) {
    if (byId.has(child)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
    }
  }
  /** @param {string} id @returns {string[]} the threads under it, nearest first */
  const descendants = (id) => {
    const found = [];
    const seen = new Set([id]);
    for (let queue = [id]; queue.length > 0;) {
      for (const child of childrenOf.get(/** @type {string} */ (queue.shift())) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          found.push(child);
          queue.push(child);
        }
      }
    }
    return found;
  };
  /** @param {string} id */
  const owned = (id) => (byId.get(id)?.owner?.account ?? null) === accountKey;

  /** @type {DeletionPlan} */
  const plan = { groups: [], blocked: [], moved: [] };
  const included = new Set();
  for (const id of new Set(ids)) {
    if (!byId.has(id)) {
      continue;
    }
    if (!owned(id)) {
      plan.moved.push(id);
      continue;
    }
    const under = descendants(id);
    const others = under.filter((child) => !owned(child));
    if (others.length > 0) {
      plan.blocked.push({ id, others });
      continue;
    }
    included.add(id);
    under.forEach((child) => included.add(child));
  }

  const parentOf = new Map(view.edges.map(({ parent, child }) => [child, parent]));
  for (const entry of view.entries) {
    const id = entry.thread.id;
    if (included.has(id) && !included.has(parentOf.get(id))) {
      plan.groups.push({ root: entry, members: [id, ...descendants(id)].map((member) => /** @type {SessionEntry} */ (byId.get(member))) });
    }
  }
  return plan;
}

/**
 * What to delete: an account's sessions (all, or the given ids, which must be
 * its own), or every session no registered account owns, each with the
 * sub-agent threads under it.
 * @param {SessionView} view
 * @param {{ accountKey: string | null, ids?: string[], all?: boolean }} selection accountKey null: the unowned ones
 * @returns {DeletionPlan}
 */
export function selectSessions(view, { accountKey, ids = [], all = false }) {
  /** @param {SessionEntry} entry */
  const ownedBySelection = (entry) => (entry.owner?.account ?? null) === accountKey;
  if (accountKey === null || all) {
    return planDeletion(view, accountKey, view.entries.filter(ownedBySelection).map((entry) => entry.thread.id));
  }
  // A prefix only needs to be unique among the account's own sessions; one that
  // isn't its own is looked up among all of them to say whose it is.
  const ownEntries = view.entries.filter(ownedBySelection);
  const resolved = ids.map((identifier) => {
    try {
      return resolveThreadIds(ownEntries, [identifier])[0];
    } catch {
      return resolveThreadIds(view.entries, [identifier])[0];
    }
  });
  const own = new Set(ownEntries.map((entry) => entry.thread.id));
  const foreign = resolved.filter((id) => !own.has(id));
  if (foreign.length > 0) {
    throw new Error(`Not this account's session(s): ${foreign.join(", ")}. See cx sessions to find their owner.`);
  }
  return planDeletion(view, accountKey, resolved);
}

/**
 * Gives sessions to an account by hand.
 * @param {string} codexHome
 * @param {string} accountKey
 * @param {string[]} identifiers
 */
export async function assignSessions(codexHome, accountKey, identifiers) {
  return withLockWhenFree(codexHome, "sessions", async () => {
    const view = await loadSessionsLocked(codexHome);
    const ids = resolveThreadIds(view.entries, identifiers);
    const owners = await readThreadOwners(codexHome);
    for (const id of ids) {
      owners.threads[id] = { account: accountKey, via: "manual", at: Date.now() };
    }
    await writeThreadOwners(codexHome, owners);
    return ids;
  });
}

/**
 * Runs `codex <args>` against this home.
 * @param {string} codexHome
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, output: string }>}
 */
function runCodex(codexHome, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
      // npm installs codex as a .cmd shim on Windows, which needs a shell.
      shell: process.platform === "win32",
      // A hung codex is ended with all it started (see process-tree.js), so it
      // can't keep writing a thread's stores after cx moved on.
      detached: DETACHED
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => killTree(child), CODEX_COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT"
        ? new Error("The codex command was not found. Install Codex to delete sessions.")
        : error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** @param {string} output */
function lastLine(output) {
  return output.trim().split(/\r?\n/).filter((line) => !line.startsWith("WARNING:")).at(-1) ?? "";
}

/**
 * Deleting a thread touches a dozen Codex stores whose schema changes between
 * versions, so cx leaves it to `codex delete`, which older Codex lacks.
 * @param {string} codexHome
 */
export async function assertCodexDeletes(codexHome) {
  const { code, output } = await runCodex(codexHome, ["delete", "--help"]);
  if (code !== 0 || !output.includes("--force")) {
    throw new Error("This Codex has no `codex delete --force`, which cx uses to delete sessions. Update Codex first (codex update).");
  }
}

/**
 * @param {string} codexHome
 * @param {string} threadId
 */
async function codexDelete(codexHome, threadId) {
  const { code, output } = await runCodex(codexHome, ["delete", "--force", threadId]);
  if (code !== 0) {
    throw new Error(code === null ? "codex delete timed out" : lastLine(output) || `codex delete exited with ${code}`);
  }
}

/**
 * Copies what Codex appends to the replaced history file until it has been
 * quiet for a while: a Codex that opened the file before the rename writes
 * there, not to the new one (POSIX only; see removeHistoryLines).
 * @param {import("node:fs/promises").FileHandle} oldHandle
 * @param {number} copied bytes of it already in the new file
 * @param {string} historyPath
 */
async function carryOverAppends(oldHandle, copied, historyPath) {
  const start = Date.now();
  let quietSince = start;
  while (Date.now() - quietSince < HISTORY_SETTLE_MS && Date.now() - start < HISTORY_SETTLE_MAX_MS) {
    const { size } = await oldHandle.stat();
    if (size > copied) {
      const appended = Buffer.alloc(size - copied);
      await oldHandle.read(appended, 0, appended.length, copied);
      await fs.appendFile(historyPath, appended);
      copied = size;
      quietSince = Date.now();
    }
    await sleep(HISTORY_POLL_MS);
  }
}

/** @param {unknown} error */
function isBusyOnWindows(error) {
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
}

/**
 * Drops the prompts of deleted threads from Codex's prompt history. Codex
 * appends to it while it runs, opening it for each prompt, and Node can't
 * take the file lock Codex holds while writing. So a rewrite that raced an
 * append is retried, and the file is replaced with a rename:
 * - POSIX: an append to the old file (by a Codex that opened it just before
 *   the rename) is carried over to the new one.
 * - Windows: a file another process has open can't be replaced, so the
 *   rename fails and is retried while Codex is appending; cx closes its own
 *   handle before the last check, so nothing can land between it and the rename
 *   but a whole open-write-close by Codex.
 * @param {string} historyPath
 * @param {Set<string>} threadIds
 */
async function removeHistoryLines(historyPath, threadIds) {
  for (let attempt = 1; attempt <= HISTORY_ATTEMPTS; attempt += 1) {
    /** @type {import("node:fs/promises").FileHandle | null} */
    let handle;
    try {
      handle = await fs.open(historyPath, "r");
    } catch (error) {
      if (isNotFound(error)) {
        return 0;
      }
      throw error;
    }
    const temporaryPath = temporaryPathFor(historyPath);
    try {
      const before = await handle.stat();
      const content = Buffer.alloc(before.size);
      await handle.read(content, 0, before.size, 0);
      const lines = content.toString("utf8").split("\n");
      const kept = lines.filter((line) => {
        try {
          return !threadIds.has(JSON.parse(line)?.session_id);
        } catch {
          return true;
        }
      });
      const removed = lines.length - kept.length;
      if (removed === 0) {
        return 0;
      }
      await fs.writeFile(temporaryPath, kept.join("\n"), { encoding: "utf8", mode: before.mode & 0o777 });
      await fs.chmod(temporaryPath, before.mode & 0o777);
      if (process.platform === "win32") {
        // Windows can't replace a file that is still open, cx's handle included.
        await handle.close();
        handle = null;
      }
      const now = await fs.stat(historyPath);
      if (now.ino !== before.ino || now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
        continue;
      }
      try {
        await fs.rename(temporaryPath, historyPath);
      } catch (error) {
        if (isBusyOnWindows(error)) {
          await sleep(HISTORY_POLL_MS);
          continue;
        }
        throw error;
      }
      if (handle) {
        await carryOverAppends(handle, before.size, historyPath);
      }
      return removed;
    } finally {
      await handle?.close();
      await fs.rm(temporaryPath, { force: true });
    }
  }
  throw new Error(`${historyPath} kept changing while cx removed the deleted sessions' prompts.`);
}

/**
 * Per-thread files `codex delete` leaves: shell snapshots, the TUI's reference
 * capabilities, and the writer lock.
 * @param {string} codexHome
 * @param {string} threadId
 */
async function removeThreadLeftovers(codexHome, threadId) {
  const paths = codexPaths(codexHome);
  const snapshots = await fs.readdir(paths.shellSnapshots).catch(() => []);
  for (const name of snapshots) {
    if (name.startsWith(`${threadId}.`)) {
      await fs.rm(path.join(paths.shellSnapshots, name), { force: true });
    }
  }
  await fs.rm(path.join(paths.threadReferenceCapabilities, threadId), { recursive: true, force: true });
  await fs.rm(path.join(paths.threadWriterLocks, `${threadId}.lock`), { force: true });
}

/**
 * @typedef {object} CleanupResult
 * @property {number} sessions deleted sessions whose cleanup finished
 * @property {number} historyLinesRemoved
 * @property {string | null} error why it couldn't finish; it is retried later
 */

/**
 * Records sessions `codex delete` just removed: they lose their owner, and
 * their prompts and leftover files are to be removed by finishSessionCleanup.
 * Done right after each delete, so a delete that is interrupted later still
 * leaves them to a later `cx sessions`. Callers hold the cx lock.
 * @param {string} codexHome
 * @param {string[]} deletedIds
 */
async function markCleanupPending(codexHome, deletedIds) {
  if (deletedIds.length === 0) {
    return;
  }
  const owners = await readThreadOwners(codexHome);
  for (const id of deletedIds) {
    delete owners.threads[id];
  }
  owners.pending_cleanup = [...new Set([...(owners.pending_cleanup ?? []), ...deletedIds])];
  await writeThreadOwners(codexHome, owners);
}

/** @returns {CleanupResult} */
const nothingCleaned = () => ({ sessions: 0, historyLinesRemoved: 0, error: null });

/**
 * Removes what deleted sessions leave outside Codex's stores: their prompts in
 * history.jsonl and their leftover files. They were recorded as pending when
 * they were deleted, so a cleanup that fails (or is interrupted) is finished
 * by a later `cx sessions`. Throws only when threads.json is unreadable; any
 * other failure is returned, as the sessions are gone either way.
 * @param {string} codexHome
 * @returns {Promise<CleanupResult>}
 */
export async function finishSessionCleanup(codexHome) {
  if (!(await readThreadOwners(codexHome)).pending_cleanup?.length) {
    return nothingCleaned();
  }
  try {
    return await withLockWhenFree(codexHome, "sessions-cleanup", async () => {
      const owners = await readThreadOwners(codexHome);
      const pending = new Set(owners.pending_cleanup ?? []);
      if (pending.size === 0) {
        return nothingCleaned();
      }
      for (const id of pending) {
        if (typeof id === "string" && SAFE_THREAD_ID.test(id)) {
          await removeThreadLeftovers(codexHome, id);
        }
      }
      const historyLinesRemoved = await removeHistoryLines(codexPaths(codexHome).history, pending);
      delete owners.pending_cleanup;
      await writeThreadOwners(codexHome, owners);
      return { sessions: pending.size, historyLinesRemoved, error: null };
    });
  } catch (error) {
    return { ...nothingCleaned(), error: errorMessage(error) };
  }
}

/**
 * @typedef {object} DeleteResult
 * @property {string[]} deleted
 * @property {string[]} inUse skipped: Codex is using them, or a sub-agent thread in their group
 * @property {string[]} moved skipped: used by another account since they were listed
 * @property {{ id: string, others: string[] }[]} blocked skipped: sub-agent threads under them have another owner
 * @property {{ id: string, message: string }[]} failed
 * @property {CleanupResult} cleanup
 */

/**
 * Deletes one group: its root with `codex delete`, which takes the sub-agent
 * threads under it along, then any of those still there (a Codex that doesn't
 * cascade). Whatever is gone afterwards counts as deleted, even if a command
 * failed. Callers hold the cx lock.
 * @param {string} codexHome
 * @param {DeletionGroup} group
 * @param {typeof codexDelete} deleteThread
 * @param {DeleteResult} result
 */
async function deleteGroup(codexHome, group, deleteThread, result) {
  const ids = group.members.map((member) => member.thread.id);
  /** @type {Map<string, string>} */
  const errors = new Map();
  /** @param {string} id */
  const attempt = async (id) => {
    try {
      await deleteThread(codexHome, id);
    } catch (error) {
      errors.set(id, errorMessage(error));
    }
  };

  await attempt(group.root.thread.id);
  try {
    const present = await readPresentThreadIds(codexHome, ids.slice(1));
    for (const id of ids.slice(1)) {
      if (present.has(id)) {
        await attempt(id);
      }
    }
    const remaining = await readPresentThreadIds(codexHome, ids);
    for (const member of group.members) {
      const { id, rolloutPath } = member.thread;
      if (remaining.has(id)) {
        result.failed.push({ id, message: errors.get(id) ?? "codex delete left it in state_5.sqlite" });
      } else if (rolloutPath && await fileExists(rolloutPath)) {
        result.failed.push({ id, message: `codex delete left its rollout file: ${rolloutPath}` });
      } else {
        result.deleted.push(id);
      }
    }
  } catch (error) {
    for (const id of ids) {
      result.failed.push({ id, message: errors.get(id) ?? `could not check that it was deleted: ${errorMessage(error)}` });
    }
  }
}

/**
 * Deletes the confirmed sessions with `codex delete`, then their prompts and
 * leftovers. Sessions are deleted under the cx lock, so a switch can't rewrite
 * their rollouts meanwhile, but in batches that let go of it in between: cx
 * warm must be able to save refreshed tokens during a long delete.
 * @param {string} codexHome
 * @param {{ accountKey: string | null, ids: string[] }} confirmed what the user agreed to delete, and whose
 * @param {{ deleteThread?: typeof codexDelete, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<DeleteResult>}
 */
export async function deleteSessions(codexHome, confirmed, { deleteThread = codexDelete, onProgress } = {}) {
  // Ownership and sub-agent threads may have changed since the list was shown:
  // delete only what still belongs to the confirmed owner.
  const plan = planDeletion(await loadSessions(codexHome), confirmed.accountKey, confirmed.ids);
  /** @type {DeleteResult} */
  const result = {
    deleted: [],
    inUse: [],
    moved: plan.moved,
    blocked: plan.blocked,
    failed: [],
    cleanup: { sessions: 0, historyLinesRemoved: 0, error: null }
  };

  const total = plan.groups.reduce((sum, group) => sum + group.members.length, 0);
  let done = 0;
  for (let start = 0; start < plan.groups.length; start += DELETE_BATCH_SIZE) {
    const batch = plan.groups.slice(start, start + DELETE_BATCH_SIZE);
    await withLockWhenFree(codexHome, "sessions-delete", async () => {
      const inUse = await findThreadsInUse(codexHome, batch.flatMap((group) => group.members.map((member) => member.thread)));
      for (const group of batch) {
        // codex delete would take an open sub-agent thread along with its root.
        if (group.members.some((member) => inUse.has(member.thread.id))) {
          result.inUse.push(...group.members.map((member) => member.thread.id));
        } else {
          const deletedBefore = result.deleted.length;
          await deleteGroup(codexHome, group, deleteThread, result);
          await markCleanupPending(codexHome, result.deleted.slice(deletedBefore));
        }
        done += group.members.length;
        onProgress?.(done, total);
      }
    });
  }

  result.cleanup = await finishSessionCleanup(codexHome)
    .catch((error) => ({ ...nothingCleaned(), error: errorMessage(error) }));
  return result;
}
