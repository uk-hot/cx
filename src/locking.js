import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_LOCK_NAME } from "./constants.js";

function lockDirPath(codexHome) {
  return path.join(codexHome, "tmp", DEFAULT_LOCK_NAME);
}

function ownerFilePath(lockDir) {
  return path.join(lockDir, "owner.json");
}

async function readLockOwner(lockDir) {
  try {
    const text = await fs.readFile(ownerFilePath(lockDir), "utf8");
    const owner = JSON.parse(text);
    return typeof owner === "object" && owner !== null ? owner : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function formatExistingLockMessage(lockDir, owner) {
  if (owner?.pid && owner?.startedAt) {
    return `Lock already exists at ${lockDir} (owner pid ${owner.pid}, started ${owner.startedAt}). Close Codex/App and retry, or remove the stale lock if you are sure no sync is running.`;
  }
  if (owner?.pid) {
    return `Lock already exists at ${lockDir} (owner pid ${owner.pid}). Close Codex/App and retry, or remove the stale lock if you are sure no sync is running.`;
  }
  return `Lock already exists at ${lockDir}. Close Codex/App and retry, or remove the stale lock if you are sure no sync is running.`;
}

async function recoverStaleLock(lockDir) {
  const owner = await readLockOwner(lockDir);
  if (!owner || isProcessRunning(owner.pid)) {
    return {
      recovered: false,
      owner
    };
  }

  await fs.rm(lockDir, { recursive: true, force: true });
  return {
    recovered: true,
    owner
  };
}

export async function acquireLock(codexHome, label = "codex-provider-sync") {
  const lockDir = lockDirPath(codexHome);
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if (error && error.code === "EEXIST") {
      const stale = await recoverStaleLock(lockDir);
      if (!stale.recovered) {
        throw new Error(formatExistingLockMessage(lockDir, stale.owner));
      }
      try {
        await fs.mkdir(lockDir);
      } catch (retryError) {
        if (retryError && retryError.code === "EEXIST") {
          throw new Error(formatExistingLockMessage(lockDir, await readLockOwner(lockDir)));
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }

  const ownerPath = ownerFilePath(lockDir);
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    label,
    cwd: process.cwd()
  };
  try {
    await fs.writeFile(ownerPath, JSON.stringify(owner, null, 2), "utf8");
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
