import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexPaths } from "./constants.js";

export const LOCK_BUSY_CODE = "CX_LOCK_BUSY";

// A lock directory without owner.json is left by a run that died between
// mkdir and writing the owner file; treat it as stale once it is this old.
const OWNERLESS_LOCK_STALE_MS = 60 * 1000;

/**
 * @typedef {{ pid?: number, startedAt?: string, label?: string, cwd?: string }} LockOwner
 */

/** @param {string} lockDir */
function ownerFilePath(lockDir) {
  return path.join(lockDir, "owner.json");
}

/**
 * @param {string} lockDir
 * @returns {Promise<LockOwner | null>}
 */
async function readLockOwner(lockDir) {
  try {
    const owner = JSON.parse(await fs.readFile(ownerFilePath(lockDir), "utf8"));
    return typeof owner === "object" && owner !== null ? owner : null;
  } catch {
    return null;
  }
}

/** @param {unknown} pid */
export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) {
    return false;
  }
  try {
    process.kill(/** @type {number} */ (pid), 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === "EPERM";
  }
}

/**
 * Whether a process that recorded `startedAt` started after the machine last
 * did. A pid recorded before that may belong to anything now.
 * @param {unknown} startedAt ISO time
 */
export function startedSinceBoot(startedAt) {
  const bootedAt = Date.now() - os.uptime() * 1000;
  return typeof startedAt === "string" && Date.parse(startedAt) > bootedAt;
}

/** @param {string} lockDir */
async function isOwnerlessLockStale(lockDir) {
  try {
    const stat = await fs.stat(lockDir);
    return Date.now() - stat.mtimeMs > OWNERLESS_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

class LockBusyError extends Error {
  code = LOCK_BUSY_CODE;

  /**
   * @param {string} lockDir
   * @param {LockOwner | null} owner
   */
  constructor(lockDir, owner) {
    const ownerDetail = owner?.pid
      ? ` (owner pid ${owner.pid}${owner.startedAt ? `, started ${owner.startedAt}` : ""})`
      : "";
    super(`Lock already exists at ${lockDir}${ownerDetail}. Close Codex/App and retry, or remove the stale lock if you are sure no sync is running.`);
    this.name = "LockBusyError";
  }
}

/**
 * Removes a lock whose owner is gone, and says whether it did.
 * @param {string} lockDir
 */
async function recoverStaleLock(lockDir) {
  const owner = await readLockOwner(lockDir);
  const stale = owner ? !isProcessRunning(owner.pid) : await isOwnerlessLockStale(lockDir);
  if (!stale) {
    return { recovered: false, owner };
  }
  await fs.rm(lockDir, { recursive: true, force: true });
  return { recovered: true, owner };
}

/** @param {string} lockDir */
async function createLockDir(lockDir) {
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "EEXIST") {
      throw error;
    }
    const stale = await recoverStaleLock(lockDir);
    if (!stale.recovered) {
      throw new LockBusyError(lockDir, stale.owner);
    }
    try {
      await fs.mkdir(lockDir);
    } catch (retryError) {
      if (/** @type {NodeJS.ErrnoException} */ (retryError)?.code === "EEXIST") {
        throw new LockBusyError(lockDir, await readLockOwner(lockDir));
      }
      throw retryError;
    }
  }
}

/**
 * Takes the cx lock of a Codex home. mkdir is atomic on every platform, so the
 * directory itself is the lock; owner.json lets a later run detect a dead owner.
 * @param {string} codexHome
 * @param {string} [label]
 * @returns {Promise<() => Promise<void>>} releases the lock; safe to call twice
 */
export async function acquireLock(codexHome, label = "cx") {
  const { lockDir } = codexPaths(codexHome);
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  await createLockDir(lockDir);

  /** @type {LockOwner} */
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), label, cwd: process.cwd() };
  try {
    await fs.writeFile(ownerFilePath(lockDir), JSON.stringify(owner, null, 2), "utf8");
  } catch (error) {
    await fs.rm(lockDir, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return async function releaseLock() {
    if (released) {
      return;
    }
    released = true;
    await fs.rm(lockDir, { recursive: true, force: true });
  };
}

/**
 * Runs `fn` while holding the cx lock.
 * @template T
 * @param {string} codexHome
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(codexHome, label, fn) {
  const releaseLock = await acquireLock(codexHome, label);
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}
