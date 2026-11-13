import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { ACCOUNT_SCOPE_KEYS, SESSION_DIRS, codexPaths } from "./constants.js";
import { errorMessage, fileExists, formatFailures, isNotFound, temporaryPathFor } from "./fs-utils.js";

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";
// libuv's UV_FS_O_EXLOCK, which Node does not export: on Windows the file is
// opened without sharing, so the open fails with EBUSY while any other process
// has it open, and nothing else can open it while cx holds it.
const UV_FS_O_EXLOCK = 0x10000000;
const EXCLUSIVE_OPEN_FLAGS = fs.constants.O_RDWR | UV_FS_O_EXLOCK;

/**
 * A rollout whose session_meta header needs rewriting, as it was when collected.
 * @typedef {object} RolloutChange
 * @property {string} path
 * @property {string | null} threadId
 * @property {string} originalFirstLine
 * @property {string} originalSeparator "\n", "\r\n", or "" for a file without one
 * @property {number} originalOffset byte offset of the second line
 * @property {number} originalSize
 * @property {number} originalMtimeMs
 * @property {string} updatedFirstLine
 */

/**
 * @typedef {{ firstLine: string, separator: string, offset: number }} FirstLineRecord
 * @typedef {"applied" | "busy" | "changed" | "missing"} RewriteStatus
 * @typedef {Record<(typeof SESSION_DIRS)[number], Map<string, number>>} ProviderCounts
 */

/** Thrown by applySessionChanges, with the files already rewritten so they can be rolled back. */
export class RolloutRewriteError extends Error {
  /**
   * @param {string} message
   * @param {{ appliedPaths: string[], cause: unknown }} details
   */
  constructor(message, { appliedPaths, cause }) {
    super(message, { cause });
    this.name = "RolloutRewriteError";
    this.appliedPaths = appliedPaths;
  }
}

// EPERM means "in use" only on Windows, where an open handle blocks a replace;
// elsewhere it is a real permission problem and must not be skipped as busy.
/** @param {unknown} error */
function isRolloutFileBusyError(error) {
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
  return code === "EBUSY" || (IS_WINDOWS && code === "EPERM");
}

/**
 * @param {unknown} error
 * @param {string} filePath
 * @param {string} action
 */
function wrapRolloutFileBusyError(error, filePath, action) {
  if (!isRolloutFileBusyError(error)) {
    return error;
  }
  return new Error(
    `Unable to ${action} rollout file because it is currently in use. Close Codex and the Codex app, then retry. Locked file: ${filePath}`,
    { cause: error }
  );
}

/**
 * @param {Pick<RolloutChange, "originalSize" | "originalMtimeMs">} change
 * @param {fs.Stats} stat
 */
function matchesCollected(change, stat) {
  return change.originalSize === stat.size && change.originalMtimeMs === stat.mtimeMs;
}

/** @param {string} rootDir */
async function listRolloutFiles(rootDir) {
  const entries = await fsp.readdir(rootDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * Reads up to the first newline only: rollouts can be large.
 * @param {fsp.FileHandle} handle
 * @returns {Promise<FirstLineRecord>}
 */
async function readFirstLine(handle) {
  const chunks = [];
  let position = 0;
  while (true) {
    const chunk = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    const newlineIndex = chunk.subarray(0, bytesRead).indexOf(0x0a);
    if (newlineIndex !== -1) {
      const collected = Buffer.concat(chunks);
      const lineEnd = position + newlineIndex;
      const crlf = lineEnd > 0 && collected[lineEnd - 1] === 0x0d;
      return {
        firstLine: collected.subarray(0, crlf ? lineEnd - 1 : lineEnd).toString("utf8"),
        separator: crlf ? "\r\n" : "\n",
        offset: lineEnd + 1
      };
    }
    position += bytesRead;
  }
  const collected = Buffer.concat(chunks);
  return { firstLine: collected.toString("utf8"), separator: "", offset: collected.length };
}

/** @param {string} filePath */
async function readFirstLineRecord(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    return await readFirstLine(handle);
  } finally {
    await handle.close();
  }
}

/** @param {string} firstLine */
function parseSessionMetaRecord(firstLine) {
  if (!firstLine) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || typeof parsed?.payload !== "object" || parsed.payload === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Codex 0.168+ tags new threads with their creator and lists only the current
// login's account-scoped threads. Absent keys mean "shared with every account",
// the state of threads created before the tagging.
/** @param {Record<string, unknown>} payload */
function hasAccountScope(payload) {
  return ACCOUNT_SCOPE_KEYS.some((key) => Object.hasOwn(payload, key));
}

/** @param {Record<string, unknown>} payload */
function clearAccountScope(payload) {
  for (const key of ACCOUNT_SCOPE_KEYS) {
    delete payload[key];
  }
}

/**
 * Opens a rollout to rewrite it. On Windows the open is exclusive, which both
 * detects a running Codex and keeps it out until the rewrite is done.
 * @param {string} filePath
 */
function openForRewrite(filePath) {
  return fsp.open(filePath, IS_WINDOWS ? EXCLUSIVE_OPEN_FLAGS : "r");
}

/**
 * Replaces a rollout's first line by writing a temporary copy and renaming it
 * over the original, keeping the file's mode. With `expected`, the file is left
 * alone ("changed") unless it is still exactly as collected.
 * @param {string} filePath
 * @param {string} firstLine
 * @param {string} separator
 * @param {RolloutChange} [expected]
 * @returns {Promise<RewriteStatus>}
 */
async function replaceFirstLine(filePath, firstLine, separator, expected) {
  /** @type {fsp.FileHandle | null} */
  let source;
  try {
    source = await openForRewrite(filePath);
  } catch (error) {
    if (isNotFound(error)) {
      return "missing";
    }
    if (isRolloutFileBusyError(error)) {
      return "busy";
    }
    throw error;
  }

  const temporaryPath = temporaryPathFor(filePath);
  try {
    const stat = await source.stat();
    if (expected && !matchesCollected(expected, stat)) {
      return "changed";
    }
    const current = await readFirstLine(source);
    if (expected && (current.firstLine !== expected.originalFirstLine || current.offset !== expected.originalOffset)) {
      return "changed";
    }

    const rest = current.offset < stat.size
      ? source.createReadStream({ start: current.offset, autoClose: false })
      : null;
    await pipeline(
      async function* () {
        yield Buffer.from(`${firstLine}${separator}`, "utf8");
        if (rest) {
          yield* rest;
        }
      },
      fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 })
    );

    // POSIX has no mandatory locks: Codex may have appended during the copy.
    if (expected && !matchesCollected(expected, await fsp.stat(filePath))) {
      return "changed";
    }

    // Windows cannot replace a file that is still open, even by cx itself.
    await source.close();
    source = null;
    await fsp.chmod(temporaryPath, stat.mode & 0o777);
    try {
      await fsp.rename(temporaryPath, filePath);
    } catch (error) {
      // Opened again between the close and the rename: the file is untouched.
      if (isRolloutFileBusyError(error)) {
        return "busy";
      }
      throw error;
    }
    return "applied";
  } catch (error) {
    throw wrapRolloutFileBusyError(error, filePath, "rewrite");
  } finally {
    await source?.close();
    await fsp.rm(temporaryPath, { force: true });
  }
}

/** @param {string[]} filePaths */
async function realpathMap(filePaths) {
  const byRealPath = new Map();
  for (const filePath of filePaths) {
    byRealPath.set(await fsp.realpath(filePath).catch(() => filePath), filePath);
  }
  return byRealPath;
}

/**
 * Windows: a rollout is in use when it cannot be opened exclusively.
 * @param {string[]} filePaths
 */
async function findOpenFilesOnWindows(filePaths) {
  const openPaths = [];
  for (const filePath of filePaths) {
    try {
      await (await fsp.open(filePath, EXCLUSIVE_OPEN_FLAGS)).close();
    } catch (error) {
      if (!isNotFound(error)) {
        openPaths.push(filePath);
      }
    }
  }
  return openPaths;
}

/**
 * Linux: a rollout is in use when any process holds a descriptor to it.
 * @param {string[]} filePaths
 */
async function findOpenFilesOnLinux(filePaths) {
  const byRealPath = await realpathMap(filePaths);
  const openPaths = new Set();
  const pids = (await fsp.readdir("/proc")).filter((name) => /^\d+$/.test(name));
  for (const pid of pids) {
    let descriptors;
    try {
      descriptors = await fsp.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const descriptor of descriptors) {
      const target = await fsp.readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => null);
      const filePath = target && byRealPath.get(target);
      if (filePath) {
        openPaths.add(filePath);
      }
    }
  }
  return [...openPaths];
}

/**
 * macOS and other POSIX systems without /proc: ask lsof.
 * @param {string[]} filePaths
 */
async function findOpenFilesWithLsof(filePaths) {
  const byRealPath = await realpathMap(filePaths);
  const openPaths = new Set();
  const realPaths = [...byRealPath.keys()];
  for (let start = 0; start < realPaths.length; start += 200) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync("lsof", ["-Fn", "--", ...realPaths.slice(start, start + 200)], {
        maxBuffer: 16 * 1024 * 1024
      }));
    } catch (error) {
      const failure = /** @type {{ code?: unknown, stdout?: string }} */ (error);
      // lsof exits 1 when some of the listed files are not open.
      if (typeof failure?.code !== "number") {
        throw new Error("Unable to verify whether rollout files are in use (lsof).", { cause: error });
      }
      stdout = failure.stdout ?? "";
    }
    for (const line of stdout.split(/\r?\n/)) {
      const filePath = line.startsWith("n") ? byRealPath.get(line.slice(1)) : null;
      if (filePath) {
        openPaths.add(filePath);
      }
    }
  }
  return [...openPaths];
}

/**
 * The paths among `filePaths` that another process has open.
 * @param {string[]} filePaths
 */
async function findOpenFiles(filePaths) {
  if (!filePaths.length) {
    return [];
  }
  if (IS_WINDOWS) {
    return findOpenFilesOnWindows(filePaths);
  }
  if (process.platform === "linux") {
    return findOpenFilesOnLinux(filePaths);
  }
  return findOpenFilesWithLsof(filePaths);
}

/**
 * Reads every rollout's header: counts its provider, and, unless `statusOnly`,
 * records the change that moves it to `targetProvider` and clears its account
 * scope. Files another process has locked for reading are listed, not read.
 * @param {string} codexHome
 * @param {string | null} targetProvider
 * @param {{ statusOnly?: boolean }} [options]
 */
export async function collectSessionChanges(codexHome, targetProvider, { statusOnly = false } = {}) {
  /** @type {RolloutChange[]} */
  const changes = [];
  /** @type {string[]} */
  const lockedPaths = [];
  const providerCounts = /** @type {ProviderCounts} */ (Object.fromEntries(SESSION_DIRS.map((dirName) => [dirName, new Map()])));

  for (const dirName of SESSION_DIRS) {
    let rolloutPaths;
    try {
      rolloutPaths = await listRolloutFiles(path.join(codexHome, dirName));
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }
    for (const rolloutPath of rolloutPaths) {
      let record;
      try {
        record = await readFirstLineRecord(rolloutPath);
      } catch (error) {
        if (isRolloutFileBusyError(error)) {
          lockedPaths.push(rolloutPath);
          continue;
        }
        throw error;
      }
      const parsed = parseSessionMetaRecord(record.firstLine);
      if (!parsed) {
        continue;
      }
      const currentProvider = parsed.payload.model_provider ?? "(missing)";
      const counts = providerCounts[dirName];
      counts.set(currentProvider, (counts.get(currentProvider) ?? 0) + 1);

      if (statusOnly || (parsed.payload.model_provider === targetProvider && !hasAccountScope(parsed.payload))) {
        continue;
      }
      const stat = await fsp.stat(rolloutPath);
      parsed.payload.model_provider = targetProvider;
      clearAccountScope(parsed.payload);
      changes.push({
        path: rolloutPath,
        threadId: parsed.payload.id ?? null,
        originalFirstLine: record.firstLine,
        originalSeparator: record.separator,
        originalOffset: record.offset,
        originalSize: stat.size,
        originalMtimeMs: stat.mtimeMs,
        updatedFirstLine: JSON.stringify(parsed)
      });
    }
  }

  return { changes, lockedPaths, providerCounts };
}

/** @param {string[]} paths */
const sorted = (paths) => paths.sort((left, right) => left.localeCompare(right));

/**
 * Rewrites the collected headers. A file that is in use or changed since it was
 * collected is skipped, not overwritten. On a failure, the error carries the
 * files already rewritten.
 * @param {RolloutChange[]} changes
 */
export async function applySessionChanges(changes) {
  /** @type {string[]} */
  const appliedPaths = [];
  /** @type {string[]} */
  const skippedPaths = [];

  for (const change of changes) {
    let status;
    try {
      status = await replaceFirstLine(change.path, change.updatedFirstLine, change.originalSeparator, change);
    } catch (error) {
      throw new RolloutRewriteError(errorMessage(error), { appliedPaths: [...appliedPaths], cause: error });
    }
    (status === "applied" ? appliedPaths : skippedPaths).push(change.path);
  }

  return { appliedPaths: sorted(appliedPaths), skippedPaths: sorted(skippedPaths) };
}

/**
 * The writer lock of each change's thread that exists. Thread ids are UUIDs;
 * anything else in a rollout header is not turned into a path.
 * @param {string} codexHome
 * @param {RolloutChange[]} changes
 */
async function writerLocksOf(codexHome, changes) {
  const lockDir = codexPaths(codexHome).threadWriterLocks;
  /** @type {Map<RolloutChange, string>} */
  const locks = new Map();
  for (const change of changes) {
    if (change.threadId && /^[0-9a-f-]+$/i.test(change.threadId)) {
      const lockPath = path.join(lockDir, `${change.threadId}.lock`);
      if (await fileExists(lockPath)) {
        locks.set(change, lockPath);
      }
    }
  }
  return locks;
}

// Rewrites replace the rollout file, so a running Codex that still has it open
// would keep appending to the replaced file and lose those events. A thread is
// in use when its rollout is open, or when Codex holds its writer lock open,
// which also covers a writer that opens the rollout only to append.
/**
 * Splits off the changes whose thread another process is writing.
 * @param {string} codexHome
 * @param {RolloutChange[]} changes
 */
export async function splitLockedSessionChanges(codexHome, changes) {
  const writerLocks = await writerLocksOf(codexHome, changes);
  const openPaths = new Set(await findOpenFiles([...changes.map((change) => change.path), ...writerLocks.values()]));
  /** @param {RolloutChange} change */
  const inUse = (change) => openPaths.has(change.path) || openPaths.has(writerLocks.get(change) ?? "");
  return {
    writableChanges: changes.filter((change) => !inUse(change)),
    lockedChanges: changes.filter(inUse)
  };
}

/**
 * Puts the original headers back after a failed sync.
 * @param {RolloutChange[]} changes
 */
export async function restoreSessionChanges(changes) {
  /** @type {{ path: string, message: string }[]} */
  const failures = [];
  for (const change of changes) {
    try {
      const status = await replaceFirstLine(change.path, change.originalFirstLine, change.originalSeparator);
      if (status !== "applied") {
        failures.push({ path: change.path, message: status === "busy" ? "in use" : "file is gone" });
      }
    } catch (error) {
      failures.push({ path: change.path, message: errorMessage(error) });
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to restore ${failures.length} rollout file(s): ${formatFailures(failures)}`);
  }
}

/** @param {ProviderCounts} providerCounts */
export function summarizeProviderCounts(providerCounts) {
  /** @type {Record<string, Record<string, number>>} */
  const result = {};
  for (const [scope, counts] of Object.entries(providerCounts)) {
    result[scope] = Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
  return result;
}
