import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { lastRefreshMs, liveLoginOf } from "./accounts.js";
import { parseAuthText } from "./auth-file.js";
import { codexPaths } from "./constants.js";
import { errorMessage, fileModeOr, isNotFound, readTextIfExists, writeFileAtomically } from "./fs-utils.js";
import { isProcessRunning, startedSinceBoot, withLockWhenFree } from "./locking.js";
import { DETACHED, killTree } from "./process-tree.js";
import { readRegistry, snapshotPaths } from "./registry.js";
import {
  MIN_WEEKLY_PERCENT_FOR_FIVE_HOUR,
  NO_SAVED_LOGIN,
  SIGN_IN_EXPIRED,
  SIGNED_OUT,
  formatDuration,
  getAccountUsage,
  weeklyTooLowForFiveHour
} from "./usage-service.js";

// A weekly (or 5-hour) window starts with the first request after the previous
// one ended. Until then it shows as full and resetting a whole window from now,
// so every hour without a request pushes its reset back. Warming sends the
// smallest Codex turn there is as soon as the window ends, so the next one runs
// from then. It runs apart from the Codex in use: each account from its own
// private Codex home, without holding the cx lock while Codex runs.

const WARM_PROMPT = "Reply with OK.";
// The prompt goes in on stdin: on Windows Codex runs through a shell, which
// would split an argument with spaces. --ephemeral writes no session, and the
// user's config (MCP servers, profiles, a third-party provider) and rules stay
// out of it. Low reasoning effort keeps the quota the request uses small.
const EXEC_ARGS = [
  "exec",
  "--ephemeral",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--sandbox",
  "read-only",
  "-c",
  "model_reasoning_effort=low",
  "--json",
  "-"
];
const EXEC_TIMEOUT_MS = 3 * 60 * 1000;
// How long a killed Codex gets to go before cx stops waiting for it.
const KILL_GRACE_MS = 5000;
// How often the warm-up home is checked for tokens Codex refreshed.
const TOKEN_POLL_MS = 1000;
const WARM_DIR_PREFIX = "cx-warm-";
const WARM_OWNER_FILE = "cx-owner.json";
// A warm-up home without an owner file is being created, unless it is this old.
const OWNERLESS_WARM_DIR_STALE_MS = 60 * 1000;
// Usage the request caused can take a moment to show up.
const VERIFY_DELAY_MS = 3000;
const RESET_GRACE_MS = 60 * 1000;
const MAX_WATCH_INTERVAL_MS = 30 * 60 * 1000;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const TRANSIENT_ERROR = /^(timed out|unreachable|HTTP 5\d\d)$/;
// 5-hour windows are kept running only for accounts with this much of the week left.
export { MIN_WEEKLY_PERCENT_FOR_FIVE_HOUR };

/** @typedef {import("./usage-service.js").Quota} Quota */
/** @typedef {import("./usage-service.js").UsageRow} UsageRow */
/** @typedef {import("./usage-service.js").FetchFn} FetchFn */
/** @typedef {{ ok: boolean, detail: string | null }} ExecResult */
/**
 * onSpawn: told the pid of the Codex process once it runs.
 * @typedef {(options: { codexHome: string, cwd: string, onSpawn?: (pid: number) => void }) => Promise<ExecResult>} RunExec
 */
/**
 * started: the window (weekly, or 5h while Codex is in use) was idle and runs now. renewed: the saved sign-in
 * had expired, so the quota was unknown; the request renewed it. renews-on-use:
 * the sign-in of the account Codex is logged in to expired; Codex renews it
 * when used, and a request meanwhile would race it for the refresh token.
 * unconfirmed: the request went through but the window still shows as not
 * started. waiting: a recent attempt failed, so this one waits.
 * @typedef {"started" | "renewed" | "renews-on-use" | "unconfirmed" | "failed" | "waiting" | "running" | "no-weekly" | "error"} WarmOutcome
 * window: the window a request was for.
 * @typedef {{ accountKey: string, label: string, outcome: WarmOutcome, attempted: boolean, window?: "weekly" | "5h", detail?: string, weekly?: Quota | null, fiveHour?: Quota | null }} WarmResult
 */

/**
 * What Codex reported: `turn.completed` means the model answered; otherwise the
 * last error event, or failing that the last line on stderr, says why not.
 * @param {number | null} code
 * @param {string} stdout JSON lines from `codex exec --json`
 * @param {string} stderr
 * @returns {ExecResult}
 */
export function interpretExecOutput(code, stdout, stderr) {
  let completed = false;
  /** @type {string | null} */
  let failure = null;
  for (const line of stdout.split(/\r?\n/)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "turn.completed") {
      completed = true;
    } else if (event?.type === "turn.failed" && typeof event.error?.message === "string") {
      failure = event.error.message;
    } else if (event?.type === "error" && typeof event.message === "string") {
      failure = event.message;
    }
  }
  if (code === 0 && completed) {
    return { ok: true, detail: null };
  }
  const lastStderrLine = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return { ok: false, detail: failure ?? lastStderrLine ?? `codex exited with code ${code}` };
}

// Every process the Codex command starts must end with it (see
// process-tree.js): one that outlives cx may still refresh tokens in a warm-up
// home after cx saved and removed it.

/** @type {Set<import("node:child_process").ChildProcess>} */
const activeExecs = new Set();

/**
 * Whether the Codex started as `pid` still runs, with anything it started.
 * @param {unknown} pid
 */
function execRunning(pid) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return isProcessRunning(pid);
  }
  try {
    process.kill(-(/** @type {number} */ (pid)), 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === "EPERM";
  }
}

/**
 * Ends the Codex requests this process is sending, for when cx itself is
 * stopped; the next cx warm recovers their warm-up homes.
 */
export function stopActiveExecs() {
  for (const child of activeExecs) {
    killTree(child);
  }
}

/**
 * Runs one non-interactive Codex turn in `codexHome`. It runs in process, not
 * through the app-server daemon, so it uses exactly the login in that home.
 * @param {{ codexHome: string, cwd: string, timeoutMs?: number, onSpawn?: (pid: number) => void }} options
 * @returns {Promise<ExecResult>}
 */
export function runCodexExec({ codexHome, cwd, timeoutMs = EXEC_TIMEOUT_MS, onSpawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", EXEC_ARGS, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
      detached: DETACHED,
      // npm installs codex as a .cmd shim on Windows, which needs a shell.
      shell: process.platform === "win32"
    });
    if (child.pid) {
      activeExecs.add(child);
      onSpawn?.(child.pid);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    /** @param {ExecResult} result */
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Codex may exit before reading the prompt.
    child.stdin.on("error", () => {});
    let timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // A Codex that survives the kill may hold the pipes open, so don't wait
      // for them to close for long.
      timer = setTimeout(() => settle({ ok: false, detail: "codex timed out" }), KILL_GRACE_MS);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      activeExecs.delete(child);
      settled = true;
      reject(/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT"
        ? new Error("The codex command was not found. Install Codex, then run cx warm again.", { cause: error })
        : error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      activeExecs.delete(child);
      if (process.platform !== "win32") {
        // Anything Codex left running in its group.
        killTree(child);
      }
      settle(timedOut ? { ok: false, detail: "codex timed out" } : interpretExecOutput(code, stdout, stderr));
    });
    child.stdin.end(`${WARM_PROMPT}\n`);
  });
}

/**
 * @param {string} codexHome
 * @param {string} accountKey
 */
function warmDirFor(codexHome, accountKey) {
  return path.join(codexPaths(codexHome).tmp, `${WARM_DIR_PREFIX}${Buffer.from(accountKey, "utf8").toString("base64url")}`);
}

/** @param {string} warmDir */
function ownerFileOf(warmDir) {
  return path.join(warmDir, WARM_OWNER_FILE);
}

/**
 * Codex refreshes the tokens of the home it runs in. A refresh token is
 * single-use, so tokens refreshed in a warm-up home must replace the account's
 * snapshot, and auth.json too while Codex is logged in to that account, or the
 * account is signed out. A running Codex rereads auth.json before it refreshes
 * and after a rejected token, so it picks them up. Older tokens never replace
 * newer ones. Callers hold the cx lock.
 * @param {string} codexHome
 * @param {string} accountKey
 * @param {string} warmDir
 */
async function saveRefreshedTokens(codexHome, accountKey, warmDir) {
  const authText = await readTextIfExists(path.join(warmDir, "auth.json"));
  const refreshed = lastRefreshMs(authText);
  if (authText === null || refreshed === null || parseAuthText(authText)?.accountKey !== accountKey) {
    return;
  }
  /** @param {string | null} text */
  const isOlder = (text) => text !== authText && (lastRefreshMs(text) ?? -Infinity) < refreshed;

  const { accounts } = await readRegistry(codexHome);
  const snapshotPath = snapshotPaths(codexHome, accountKey).auth;
  if (accounts.some((account) => account.account_key === accountKey) && isOlder(await readTextIfExists(snapshotPath))) {
    await writeFileAtomically(snapshotPath, authText);
  }
  const paths = codexPaths(codexHome);
  const liveText = await readTextIfExists(paths.auth);
  if (liveLoginOf(liveText, await readTextIfExists(paths.config))?.accountKey === accountKey && isOlder(liveText)) {
    await writeFileAtomically(paths.auth, authText, { mode: await fileModeOr(paths.auth, 0o600) });
  }
}

/**
 * Removes a warm-up home whose cx is gone, after saving any tokens Codex
 * refreshed in it, which may be the only valid ones. Says whether it was
 * removed; one that is still in use is left alone.
 * @param {string} codexHome
 * @param {string} accountKey
 * @param {string} warmDir
 */
async function recoverWarmDir(codexHome, accountKey, warmDir) {
  if (await warmDirState(warmDir) === "in-use") {
    return false;
  }
  // Checked again under the lock: another cx may have recovered and claimed it
  // meanwhile. While the abandoned home exists nobody can claim it, so nothing
  // can take its place before it is removed.
  return withLockWhenFree(codexHome, "warm", async () => {
    const state = await warmDirState(warmDir);
    if (state !== "abandoned") {
      return state === "gone";
    }
    await saveRefreshedTokens(codexHome, accountKey, warmDir);
    await fs.rm(warmDir, { recursive: true, force: true });
    return true;
  });
}

/**
 * A warm-up home is in use while the cx that owns it runs, and while the Codex
 * it started does, which may outlive a cx that was killed. One owned by this
 * process whose Codex ended is left over from an earlier pass whose save
 * failed: a process warms one account at a time. Pids recorded before the
 * machine started don't count. One without an owner file is still being set
 * up, unless it is old.
 * @param {string} warmDir
 * @returns {Promise<"gone" | "in-use" | "abandoned">}
 */
async function warmDirState(warmDir) {
  let stat;
  try {
    stat = await fs.stat(warmDir);
  } catch (error) {
    if (isNotFound(error)) {
      return "gone";
    }
    throw error;
  }
  let owner = null;
  try {
    owner = JSON.parse(await fs.readFile(ownerFileOf(warmDir), "utf8"));
  } catch {
    // Not written yet, or the run died before writing it.
  }
  if (owner) {
    const current = startedSinceBoot(owner.startedAt);
    const ownerRuns = owner.pid !== process.pid && isProcessRunning(owner.pid);
    return current && (ownerRuns || execRunning(owner.execPid)) ? "in-use" : "abandoned";
  }
  return Date.now() - stat.mtimeMs < OWNERLESS_WARM_DIR_STALE_MS ? "in-use" : "abandoned";
}

/**
 * Recovers every warm-up home left behind by a cx that was killed.
 * @param {string} codexHome
 */
async function recoverWarmDirs(codexHome) {
  let entries;
  try {
    entries = await fs.readdir(codexPaths(codexHome).tmp);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
  for (const entry of entries.filter((name) => name.startsWith(WARM_DIR_PREFIX))) {
    const accountKey = Buffer.from(entry.slice(WARM_DIR_PREFIX.length), "base64url").toString("utf8");
    await recoverWarmDir(codexHome, accountKey, path.join(codexPaths(codexHome).tmp, entry));
  }
}

/**
 * The newest login of the account: auth.json while Codex is logged in to it,
 * where Codex refreshes it, otherwise its snapshot.
 * @param {string} codexHome
 * @param {string} accountKey
 */
async function currentAuthTextOf(codexHome, accountKey) {
  const paths = codexPaths(codexHome);
  const liveText = await readTextIfExists(paths.auth);
  if (liveLoginOf(liveText, await readTextIfExists(paths.config))?.accountKey === accountKey) {
    return liveText;
  }
  const snapshotText = await readTextIfExists(snapshotPaths(codexHome, accountKey).auth);
  return parseAuthText(snapshotText)?.accountKey === accountKey ? snapshotText : null;
}

/**
 * Whether Codex is logged in to the account.
 * @param {string} codexHome
 * @param {string} accountKey
 */
async function isLoggedInTo(codexHome, accountKey) {
  const paths = codexPaths(codexHome);
  return liveLoginOf(await readTextIfExists(paths.auth), await readTextIfExists(paths.config))?.accountKey === accountKey;
}

/**
 * Saves the tokens Codex refreshes in a warm-up home as soon as they appear,
 * not only once Codex is done. Until then a Codex using the same login
 * elsewhere (the account Codex is logged in to, or one `cx switch` just
 * switched to) would refresh with a refresh token already used up, which signs
 * the account out.
 * @param {string} codexHome
 * @param {string} accountKey
 * @param {string} warmDir
 * @param {string} initialText the auth.json the home started with
 */
function watchRefreshedTokens(codexHome, accountKey, warmDir, initialText) {
  const authPath = path.join(warmDir, "auth.json");
  let stopped = false;
  let wake = () => {};
  const loop = (async () => {
    let seen = initialText;
    while (!stopped) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, TOKEN_POLL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve(undefined);
        };
      });
      const text = stopped ? null : await readTextIfExists(authPath).catch(() => null);
      if (text !== null && text !== seen) {
        // A half-written file is passed over, and saved once it is complete.
        seen = text;
        // They are saved again once Codex is done, so a failure only costs time.
        await withLockWhenFree(codexHome, "warm", () => saveRefreshedTokens(codexHome, accountKey, warmDir)).catch(() => {});
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake();
      await loop;
    }
  };
}

/**
 * Sends one minimal Codex turn as the account from a private Codex home that
 * holds a copy of its login, so nothing in ~/.codex is used: not its config,
 * sessions, logs or daemon, and not the cx lock, so `cx switch` keeps working
 * meanwhile. Tokens Codex refreshes there are saved back as soon as they
 * appear. The home itself marks the account as being warmed, so two cx runs
 * never warm the same account at once.
 * @param {string} codexHome
 * @param {string} accountKey
 * @param {{ runExec?: RunExec }} [options]
 * @returns {Promise<ExecResult & { busy?: boolean }>}
 */
export async function warmAccount(codexHome, accountKey, { runExec = runCodexExec } = {}) {
  const warmDir = warmDirFor(codexHome, accountKey);
  await fs.mkdir(codexPaths(codexHome).tmp, { recursive: true });
  if (!await claimDir(warmDir) && !(await recoverWarmDir(codexHome, accountKey, warmDir) && await claimDir(warmDir))) {
    return { ok: false, busy: true, detail: "another cx warm is sending a request as this account" };
  }
  const owner = { pid: process.pid, startedAt: new Date().toISOString() };
  /** @param {{ execPid?: number }} [extra] */
  const writeOwner = (extra = {}) => writeFileAtomically(ownerFileOf(warmDir), JSON.stringify({ ...owner, ...extra }));
  let keepWarmDir = false;
  try {
    await writeOwner();
    const authText = await currentAuthTextOf(codexHome, accountKey);
    if (authText === null) {
      return { ok: false, detail: NO_SAVED_LOGIN };
    }
    await writeFileAtomically(path.join(warmDir, "auth.json"), authText);
    // Keep this machine's Codex installation id instead of minting a new one.
    await fs.copyFile(path.join(codexHome, "installation_id"), path.join(warmDir, "installation_id")).catch(() => {});
    /** @type {number | undefined} */
    let execPid;
    /** @type {Promise<void>} */
    let ownerUpdated = Promise.resolve();
    const tokenWatch = watchRefreshedTokens(codexHome, accountKey, warmDir, authText);
    try {
      return await runExec({
        codexHome: warmDir,
        cwd: warmDir,
        onSpawn: (pid) => {
          execPid = pid;
          // So that a later cx leaves the home alone while this Codex runs,
          // should this cx be killed first.
          ownerUpdated = writeOwner({ execPid: pid }).catch(() => {});
        }
      });
    } finally {
      await tokenWatch.stop();
      await ownerUpdated;
      // A Codex that survived being killed may still refresh tokens there: the
      // home stays for a later run to recover once it ended.
      keepWarmDir = execRunning(execPid);
      try {
        await withLockWhenFree(codexHome, "warm", () => saveRefreshedTokens(codexHome, accountKey, warmDir));
      } catch (error) {
        // The next run recovers them from the warm-up home.
        keepWarmDir = true;
        throw new Error("Could not save the tokens Codex refreshed.", { cause: error });
      }
    }
  } finally {
    if (!keepWarmDir) {
      await fs.rm(warmDir, { recursive: true, force: true });
    }
  }
}

/**
 * Creates the directory, or returns false when it exists: mkdir is atomic.
 * @param {string} dir
 */
async function claimDir(dir) {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the account's 5-hour window is worth starting while Codex is in use:
 * not with less than MIN_WEEKLY_PERCENT_FOR_FIVE_HOUR of the week left.
 * @param {{ fiveHour?: Quota | null, weekly?: Quota | null }} usage
 */
function fiveHourEligible({ fiveHour, weekly }) {
  return Boolean(fiveHour) && !weeklyTooLowForFiveHour(weekly);
}

/**
 * What to do for an account: send a request for one of these reasons, or
 * nothing, with the result to report.
 * @param {UsageRow} row
 * @param {boolean} codexActive
 * @returns {"weekly" | "5h" | "expired" | WarmResult}
 */
function classify(row, codexActive) {
  const base = { accountKey: row.accountKey, label: row.label, attempted: false };
  if (row.error === SIGN_IN_EXPIRED) {
    // The quota can't be read until Codex renews the sign-in, which a warm-up does.
    return "expired";
  }
  if (row.error) {
    return { ...base, outcome: "error", detail: row.error };
  }
  if (row.weekly?.idle) {
    return "weekly";
  }
  if (codexActive && row.fiveHour?.idle && fiveHourEligible(row)) {
    return "5h";
  }
  const quotas = { weekly: row.weekly ?? null, fiveHour: row.fiveHour ?? null };
  return row.weekly ? { ...base, outcome: "running", ...quotas } : { ...base, outcome: "no-weekly", ...quotas };
}

/**
 * One pass over every official account. A weekly window that hasn't started is
 * started with a minimal Codex turn, and so is an account whose saved sign-in
 * expired, because its quota can't be read otherwise, unless Codex is logged in
 * to it. While Codex is in use,
 * so is every 5-hour window that hasn't started, of the accounts with at least
 * MIN_WEEKLY_PERCENT_FOR_FIVE_HOUR of their week left: the account being used
 * started its own, and the others are then ready to take over with a window
 * that is already running down.
 * @param {string} codexHome
 * @param {{ fetchFn?: FetchFn, runExec?: RunExec, skip?: (accountKey: string) => boolean, verifyDelayMs?: number, codexActive?: boolean }} [options]
 *   skip: accounts not to send a request for this time; codexActive: whether
 *   Codex is in use, see isCodexActive
 * @returns {Promise<WarmResult[]>}
 */
export async function warmAccounts(codexHome, {
  fetchFn,
  runExec,
  skip = () => false,
  verifyDelayMs = VERIFY_DELAY_MS,
  codexActive = false
} = {}) {
  await recoverWarmDirs(codexHome);
  /** @type {WarmResult[]} */
  const results = [];
  for (const row of await getAccountUsage(codexHome, { fetchFn })) {
    const reason = classify(row, codexActive);
    if (typeof reason === "object") {
      results.push(reason);
      continue;
    }
    const window = /** @type {"weekly" | "5h"} */ (reason === "5h" ? "5h" : "weekly");
    const base = { accountKey: row.accountKey, label: row.label, window };
    // An expired sign-in is renewed on the first refresh, so a Codex started
    // meanwhile would race the request for the refresh token. Codex renews the
    // one it is logged in to itself when it is used.
    if (reason === "expired" && await isLoggedInTo(codexHome, row.accountKey)) {
      results.push({ accountKey: row.accountKey, label: row.label, outcome: "renews-on-use", attempted: false });
      continue;
    }
    if (skip(row.accountKey)) {
      results.push({ ...base, outcome: "waiting", attempted: false, weekly: row.weekly ?? null, fiveHour: row.fiveHour ?? null });
      continue;
    }
    let exec;
    try {
      exec = await warmAccount(codexHome, row.accountKey, { runExec });
    } catch (error) {
      results.push({ ...base, outcome: "failed", attempted: true, detail: errorMessage(error) });
      continue;
    }
    if (!exec.ok) {
      results.push({ ...base, outcome: "failed", attempted: !exec.busy, detail: exec.detail ?? "unknown error" });
      continue;
    }
    await delay(verifyDelayMs);
    const [after] = await getAccountUsage(codexHome, { fetchFn, accountKeys: [row.accountKey] });
    const quotas = { weekly: after?.weekly ?? null, fiveHour: after?.fiveHour ?? null };
    const target = window === "5h" ? quotas.fiveHour : quotas.weekly;
    // A renewed sign-in shows in the quota being readable again; a plan may have
    // no weekly window at all.
    if (reason === "expired" ? after && !after.error : target && !target.idle) {
      results.push({ ...base, outcome: reason === "expired" ? "renewed" : "started", attempted: true, ...quotas });
    } else {
      results.push({ ...base, outcome: "unconfirmed", attempted: true, ...quotas, detail: after?.error });
    }
  }
  return results;
}

/**
 * When `cx warm --watch` checks next: shortly after the earliest weekly reset,
 * and while Codex is in use also after the earliest 5-hour reset of an account
 * whose window is kept running; sooner after a failure that may pass, and at
 * least every half hour, which also picks up accounts added or signed in again
 * meanwhile.
 * @param {WarmResult[]} results
 * @param {number} now ms
 * @param {{ codexActive?: boolean }} [options]
 */
export function nextWarmCheck(results, now, { codexActive = false } = {}) {
  const retry = results.some((result) => result.outcome === "unconfirmed"
    || (result.outcome === "failed" && !result.attempted)
    || (result.outcome === "error" && TRANSIENT_ERROR.test(result.detail ?? "")));
  /** @param {Quota | null | undefined} quota */
  const resetOf = (quota) => (quota && !quota.idle && quota.resetsAt !== null ? [quota.resetsAt * 1000 + RESET_GRACE_MS] : []);
  const resets = results.flatMap((result) => [
    ...resetOf(result.weekly),
    ...(codexActive && fiveHourEligible(result) ? resetOf(result.fiveHour) : [])
  ]);
  return Math.min(now + (retry ? RETRY_INTERVAL_MS : MAX_WATCH_INTERVAL_MS), ...resets.filter((time) => time > now));
}

/**
 * @param {Quota | null | undefined} quota
 * @param {number} nowSeconds
 */
function resetsIn(quota, nowSeconds) {
  return quota?.resetsAt != null ? `resets in ${formatDuration(quota.resetsAt - nowSeconds)}` : "reset time unknown";
}

/**
 * @param {WarmResult} result
 * @param {number} nowSeconds
 */
function describe(result, nowSeconds) {
  const left = result.weekly ? `${Math.round(result.weekly.remainingPercent)}% left, ` : "";
  const windowName = result.window === "5h" ? "5-hour" : "weekly";
  switch (result.outcome) {
    case "started":
      return `${windowName} window started (${resetsIn(result.window === "5h" ? result.fiveHour : result.weekly, nowSeconds)})`;
    case "renewed":
      return `sign-in renewed; weekly window running (${left}${resetsIn(result.weekly, nowSeconds)})`;
    case "renews-on-use":
      return "sign-in expired; Codex is logged in to it and renews it when you use it";
    case "running":
      return `weekly window running (${left}${resetsIn(result.weekly, nowSeconds)})`;
    case "unconfirmed":
      return `request sent, but the ${windowName} window still shows as not started${result.detail ? ` (${result.detail})` : ""}`;
    case "failed":
      return `could not send a request: ${result.detail}`;
    case "waiting":
      return `${windowName} window not started; the last attempt failed, retrying later`;
    case "no-weekly":
      return "no weekly limit";
    case "error":
      return result.detail === SIGNED_OUT || result.detail === NO_SAVED_LOGIN
        ? `${result.detail}; sign in again with cx add`
        : String(result.detail);
  }
}

/**
 * @param {WarmResult[]} results
 * @param {{ now?: number }} [options]
 */
export function renderWarmResults(results, { now = Date.now() } = {}) {
  if (!results.length) {
    return "No accounts signed in with ChatGPT.";
  }
  const nowSeconds = Math.floor(now / 1000);
  const width = Math.max(...results.map((result) => result.label.length));
  return results.map((result) => `${result.label.padEnd(width)}  ${describe(result, nowSeconds)}`).join("\n");
}

const NO_ACCOUNTS_KEY = "";

/**
 * What an account's state is, apart from the countdown: a running window that
 * keeps running is no news.
 * @param {WarmResult} result
 */
function stateKey(result) {
  return result.outcome === "running" || result.outcome === "no-weekly"
    ? "ok"
    : [result.outcome, result.window ?? "", result.detail ?? ""].join("|");
}

/**
 * Only what changed since the state `previous` describes, for the log of `cx
 * warm --watch`; everything the first time.
 * @param {WarmResult[]} results
 * @param {Map<string, string>} previous state keys of the last pass, empty at first
 * @param {{ now?: number }} [options]
 * @returns {{ text: string, state: Map<string, string> }}
 */
export function renderWarmChanges(results, previous, { now = Date.now() } = {}) {
  const state = new Map(results.length ? results.map((result) => [result.accountKey, stateKey(result)]) : [[NO_ACCOUNTS_KEY, "none"]]);
  if (!results.length) {
    return { text: previous.get(NO_ACCOUNTS_KEY) === "none" ? "" : renderWarmResults(results), state };
  }
  const changed = results.filter((result) => previous.get(result.accountKey) !== state.get(result.accountKey));
  return { text: changed.length ? renderWarmResults(changed, { now }) : "", state };
}

/** @param {WarmResult[]} results */
export function warmFailed(results) {
  return results.some((result) => result.outcome === "failed" || result.outcome === "unconfirmed");
}
