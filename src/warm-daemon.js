import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { codexPaths } from "./constants.js";
import { errorMessage, isNotFound, readTextIfExists, writeFileAtomically } from "./fs-utils.js";
import { isProcessRunning, startedSinceBoot } from "./locking.js";

// `cx warm start` runs `cx warm --watch` as a detached background process and
// remembers that it should run, so any later cx command starts it again after
// a reboot or a crash. Only one watcher runs per Codex home, in the background
// or in a terminal.

const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));
const LOG_MAX_BYTES = 1024 * 1024;
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 5000;
const POLL_MS = 100;
// After the background watcher failed to start, cx commands don't try again for
// this long, so each of them doesn't wait for it and warn.
const REVIVE_RETRY_MS = 10 * 60 * 1000;
const execFileAsync = promisify(execFile);

/** @param {string} codexHome */
export function warmPaths(codexHome) {
  const paths = codexPaths(codexHome);
  return {
    settings: path.join(paths.accounts, "cx-warm.json"),
    pid: path.join(paths.tmp, "cx-warm.pid"),
    startFailed: path.join(paths.tmp, "cx-warm.start-failed"),
    log: path.join(codexHome, "log", "cx-warm.log")
  };
}

/**
 * When the background watcher last failed to start, or null.
 * @param {string} codexHome
 * @returns {Promise<{ at: number, error: string } | null>}
 */
async function readStartFailure(codexHome) {
  try {
    const failure = JSON.parse(await readTextIfExists(warmPaths(codexHome).startFailed) ?? "null");
    const at = Date.parse(failure?.at);
    return Number.isFinite(at) ? { at, error: String(failure.error ?? "") } : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} codexHome
 * @param {unknown} error
 */
async function recordStartFailure(codexHome, error) {
  const { startFailed } = warmPaths(codexHome);
  await fs.mkdir(path.dirname(startFailed), { recursive: true });
  await writeFileAtomically(startFailed, JSON.stringify({ at: new Date().toISOString(), error: errorMessage(error) }));
}

/** @param {string} codexHome */
async function clearStartFailure(codexHome) {
  await fs.rm(warmPaths(codexHome).startFailed, { force: true });
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The command line of a process, or null where it can't be read (Windows).
 * @param {number} pid
 */
async function commandLineOf(pid) {
  try {
    return await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    // No /proc: macOS and the BSDs have ps.
  }
  if (process.platform === "win32") {
    return null;
  }
  try {
    return (await execFileAsync("ps", ["-o", "command=", "-p", String(pid)])).stdout;
  } catch {
    return null;
  }
}

/**
 * The pid of the running watcher, or null. A pid file left by a watcher that
 * died, or written before the machine last started (its pid may belong to
 * anything now), doesn't count, nor does a pid that now runs another program.
 * @param {string} codexHome
 */
export async function runningWatcherPid(codexHome) {
  return watcherPidIn(await readTextIfExists(warmPaths(codexHome).pid).catch(() => null));
}

/**
 * The watcher a pid file's text names, if it still runs.
 * @param {string | null} text
 */
async function watcherPidIn(text) {
  let owner;
  try {
    owner = JSON.parse(text ?? "");
  } catch {
    return null;
  }
  const pid = owner?.pid;
  if (!isProcessRunning(pid) || !startedSinceBoot(owner?.startedAt)) {
    return null;
  }
  const commandLine = await commandLineOf(pid);
  return commandLine === null || commandLine.includes("warm") ? /** @type {number} */ (pid) : null;
}

/**
 * Makes this process the watcher of the Codex home. Returns the pid of the one
 * already running instead, if any. The pid file is removed when this process
 * exits.
 * @param {string} codexHome
 * @returns {Promise<{ claimed: true } | { claimed: false, pid: number }>}
 */
export async function claimWatcher(codexHome) {
  const pidPath = warmPaths(codexHome).pid;
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  // The pid file appears complete or not at all: written aside, then linked
  // into place, which fails if it exists. A file created empty and written
  // afterwards would look stale to a second watcher in between.
  const draft = `${pidPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(draft, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    for (;;) {
      try {
        await fs.link(draft, pidPath);
        break;
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "EEXIST") {
          throw error;
        }
      }
      const text = await readTextIfExists(pidPath);
      const pid = await watcherPidIn(text);
      if (pid !== null) {
        return { claimed: false, pid };
      }
      // Only the stale file just read: another watcher may have replaced it.
      if (await readTextIfExists(pidPath) === text) {
        await fs.rm(pidPath, { force: true });
      }
    }
  } finally {
    await fs.rm(draft, { force: true });
  }
  process.once("exit", () => {
    try {
      if (JSON.parse(readFileSync(pidPath, "utf8"))?.pid === process.pid) {
        unlinkSync(pidPath);
      }
    } catch {
      // Already gone.
    }
  });
  return { claimed: true };
}

/** @param {string} codexHome */
async function readSettings(codexHome) {
  try {
    const settings = JSON.parse(await readTextIfExists(warmPaths(codexHome).settings) ?? "{}");
    return { background: settings?.background === true };
  } catch {
    return { background: false };
  }
}

/**
 * @param {string} codexHome
 * @param {boolean} background
 */
async function writeSettings(codexHome, background) {
  const settingsPath = warmPaths(codexHome).settings;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  await writeFileAtomically(settingsPath, JSON.stringify({ background }, null, 2));
}

/** @param {string} logPath */
async function rotateLog(logPath) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  try {
    if ((await fs.stat(logPath)).size > LOG_MAX_BYTES) {
      await fs.rename(logPath, `${logPath}.1`);
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

/**
 * @param {string} codexHome
 * @returns {Promise<number>}
 */
async function spawnWatcher(codexHome) {
  const { log } = warmPaths(codexHome);
  await rotateLog(log);
  const logFd = openSync(log, "a");
  let child;
  try {
    child = spawn(process.execPath, [CLI_PATH, "warm", "--watch"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true
    });
  } finally {
    closeSync(logFd);
  }
  /** @type {number | null} */
  let exitCode = null;
  child.once("exit", (code) => {
    exitCode = code ?? -1;
  });
  child.unref();
  // It is up once it has claimed the pid file.
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += POLL_MS) {
    const running = await runningWatcherPid(codexHome);
    // Another cx started one at the same moment, and this one gave way.
    if (running !== null && (running === child.pid || exitCode !== null)) {
      return running;
    }
    if (exitCode !== null) {
      throw new Error(`The background cx warm exited at once (code ${exitCode}). See ${log}`);
    }
    await delay(POLL_MS);
  }
  throw new Error(`The background cx warm did not start in time. See ${log}`);
}

/**
 * Starts the background watcher and keeps it on across cx runs.
 * @param {string} codexHome
 * @returns {Promise<{ status: "started" | "already-running", pid: number, log: string }>}
 */
export async function startBackgroundWarm(codexHome) {
  await writeSettings(codexHome, true);
  await clearStartFailure(codexHome);
  const { log } = warmPaths(codexHome);
  const running = await runningWatcherPid(codexHome);
  if (running !== null) {
    return { status: "already-running", pid: running, log };
  }
  return { status: "started", pid: await spawnWatcher(codexHome), log };
}

/**
 * Turns the background watcher off and stops whichever watcher runs. On being
 * stopped it ends the Codex request it is sending, if any; the next cx warm
 * recovers what that request left behind.
 * @param {string} codexHome
 * @returns {Promise<{ status: "stopped" | "not-running", pid?: number }>}
 */
export async function stopBackgroundWarm(codexHome) {
  await writeSettings(codexHome, false);
  await clearStartFailure(codexHome);
  const pid = await runningWatcherPid(codexHome);
  if (pid === null) {
    return { status: "not-running" };
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {
    // Not a group leader (a watcher started in a terminal).
    process.kill(pid, "SIGTERM");
  }
  for (let waited = 0; waited < STOP_TIMEOUT_MS && isProcessRunning(pid); waited += POLL_MS) {
    await delay(POLL_MS);
  }
  if (isProcessRunning(pid)) {
    throw new Error(`cx warm (pid ${pid}) did not stop.`);
  }
  await fs.rm(warmPaths(codexHome).pid, { force: true });
  return { status: "stopped", pid };
}

/**
 * Starts the background watcher again if it should run but doesn't, e.g.
 * after a reboot. Returns its pid when it started it. After a failed start it
 * waits REVIVE_RETRY_MS before trying again.
 * @param {string} codexHome
 * @param {{ now?: number }} [options]
 */
export async function reviveBackgroundWarm(codexHome, { now = Date.now() } = {}) {
  if (!(await readSettings(codexHome)).background || await runningWatcherPid(codexHome) !== null) {
    return null;
  }
  const failure = await readStartFailure(codexHome);
  if (failure && now - failure.at < REVIVE_RETRY_MS && failure.at <= now) {
    return null;
  }
  try {
    const pid = await spawnWatcher(codexHome);
    await clearStartFailure(codexHome);
    return pid;
  } catch (error) {
    await recordStartFailure(codexHome, error).catch(() => {});
    throw error;
  }
}

/**
 * background: whether it should run; startFailure: why it last failed to
 * start, while that is unresolved.
 * @param {string} codexHome
 * @returns {Promise<{ background: boolean, pid: number | null, log: string, startFailure: { at: number, error: string } | null }>}
 */
export async function backgroundWarmStatus(codexHome) {
  const pid = await runningWatcherPid(codexHome);
  return {
    background: (await readSettings(codexHome)).background,
    pid,
    log: warmPaths(codexHome).log,
    startFailure: pid === null ? await readStartFailure(codexHome) : null
  };
}
