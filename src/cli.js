#!/usr/bin/env node

import os from "node:os";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  addAccount,
  addAccountWithLogin,
  addNeedsLogin,
  removeAccount,
  syncActiveAccountFromCurrentAuth
} from "./accounts.js";
import { restartCodexDaemon } from "./codex-daemon.js";
import { runCodexForLogin } from "./codex-login.js";
import { defaultCodexHome } from "./constants.js";
import { errorMessage } from "./fs-utils.js";
import {
  accountDisplayName,
  findAccountsByIdentifier,
  getCurrentAccount,
  isExactAccountMatch,
  listAccounts
} from "./registry.js";
import { getStatus, renderStatus, runSwitch, runSync } from "./service.js";
import { shellArgument } from "./terminal-ui.js";
import { renderAccountUsage } from "./usage-service.js";
import {
  backgroundWarmStatus,
  claimWatcher,
  reviveBackgroundWarm,
  startBackgroundWarm,
  stopBackgroundWarm
} from "./warm-daemon.js";
import { isCodexActive } from "./codex-activity.js";
import {
  nextWarmCheck,
  renderWarmChanges,
  renderWarmResults,
  stopActiveExecs,
  warmAccounts,
  warmFailed
} from "./warm-service.js";

/** @typedef {import("./registry.js").Account} Account */
/** @typedef {import("./service.js").SyncResult} SyncResult */

const codexHome = defaultCodexHome();

/**
 * @typedef {object} Command
 * @property {string} usage
 * @property {string[]} summary help text, one entry per line
 * @property {number} maxArgs
 * @property {string[]} [flags] long options the command accepts besides --help
 * @property {(args: string[], flags: Record<string, unknown>) => Promise<void>} run
 */

/** @type {Record<string, Command>} */
const COMMANDS = {
  status: {
    usage: "cx status",
    summary: ["Show provider sync state and each account's quota"],
    maxArgs: 0,
    run: () => printStatus()
  },
  switch: {
    usage: "cx switch <email|alias>",
    summary: ["Switch Codex to a registered account"],
    maxArgs: 1,
    run: ([identifier]) => switchAccount(identifier)
  },
  add: {
    usage: "cx add [alias]",
    summary: ["Sign in to a new account, or again to a registered", "one whose login expired or was signed out"],
    maxArgs: 1,
    run: ([alias]) => addAccountCommand(alias)
  },
  warm: {
    usage: "cx warm [start|stop|--watch]",
    summary: [
      "Start weekly quota windows that haven't started yet (and",
      "5-hour ones while Codex is in use);",
      "start: keep doing it in the background as each one",
      "resets; stop: turn that off; --watch: same, in this terminal"
    ],
    maxArgs: 1,
    flags: ["watch"],
    run: ([action], flags) => warmCommand(action, Boolean(flags.watch))
  },
  list: {
    usage: "cx list",
    summary: ["List registered accounts"],
    maxArgs: 0,
    run: () => listAccountsCommand()
  },
  remove: {
    usage: "cx remove <email|alias>",
    summary: ["Remove a registered account"],
    maxArgs: 1,
    run: ([identifier]) => removeAccountCommand(identifier)
  }
};

function printHelp() {
  const width = Math.max(...Object.values(COMMANDS).map((command) => command.usage.length)) + 2;
  const lines = Object.values(COMMANDS).flatMap(({ usage, summary }) => summary.map((text, index) =>
    `  ${(index === 0 ? usage : "").padEnd(width)}${text}`));
  console.log(`cx\n\nUsage:\n${lines.join("\n")}\n`);
}

/** @param {SyncResult} result @param {string} label */
function summarizeSync(result, label) {
  const lines = [
    `${label} provider: ${result.targetProvider}`,
    `Codex home: ${result.codexHome}`,
    `Updated rollout files: ${result.changedSessionFiles}`,
    `Updated SQLite rows: ${result.sqliteRowsUpdated}${result.sqlitePresent ? "" : " (state_5.sqlite not found)"}`
  ];
  const skipped = result.skippedLockedRolloutFiles;
  if (skipped.length) {
    const extraCount = skipped.length - Math.min(skipped.length, 5);
    lines.push(`Skipped locked rollout files: ${skipped.length}`);
    lines.push(`Locked file(s): ${skipped.slice(0, 5).join(", ")}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`);
  }
  return lines.join("\n");
}

/** @param {{ email: string | null, accountKey: string, alias?: string }} result */
function printAddedAccount(result) {
  console.log(`Added account: ${result.email ?? result.accountKey}${result.alias ? ` (alias: ${result.alias})` : ""}`);
}

// Runs after the login in ~/.codex changed. The command already succeeded, so a
// failed restart is a warning with the manual fix, not an error. Returns whether
// the daemon was restarted.
async function restartDaemonForNewLogin() {
  let result;
  try {
    result = await restartCodexDaemon(codexHome);
  } catch (error) {
    result = { status: "failed", detail: errorMessage(error) };
  }
  if (result.status === "restarted") {
    console.log("Restarted the Codex app-server daemon so it uses this login. Reopen Codex sessions that were running (codex resume).");
  } else if (result.status === "failed") {
    console.warn(`Could not restart the Codex app-server daemon (${result.detail}). It still uses the previous login; run: codex app-server daemon restart`);
  }
  return result.status === "restarted";
}

// The daemon keeps the rollout files of open sessions open, so the switch had to
// skip them. Its restart closed them: sync them now instead of on the next switch.
/** @param {SyncResult} switchResult */
async function resyncSkippedRollouts(switchResult) {
  try {
    const result = await runSync({ codexHome, provider: switchResult.targetProvider });
    console.log(summarizeSync(result, "Re-synchronized"));
  } catch (error) {
    console.warn(`Could not sync the rollout files skipped by the switch (${errorMessage(error)}). Run cx switch again to sync them.`);
  }
}

/** @param {Account} account */
function accountLabel(account) {
  return `${accountDisplayName(account)}${account.provider ? ` [${account.provider}]` : ""}`;
}

/**
 * @param {Account[]} accounts
 * @param {string | null} activeKey
 */
function renderRegisteredAccounts(accounts, activeKey) {
  const labelWidth = Math.max(...accounts.map((account) => accountDisplayName(account).length), 0);
  const lines = [`Registered accounts (${accounts.length}):`];
  for (const account of accounts) {
    const isActive = account.account_key === activeKey;
    lines.push(`${isActive ? "*" : " "} ${accountDisplayName(account).padEnd(labelWidth)}  ${account.provider ?? "-"}${isActive ? "  (active)" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Turns an ambiguous or partial identifier into one account key by asking in a
 * TTY. Returns the identifier unchanged when it already names one account.
 * @param {string | undefined} identifier
 * @param {"switch" | "remove"} action
 */
async function resolveAccountIdentifier(identifier, action) {
  if (!identifier) {
    return identifier;
  }

  const matches = findAccountsByIdentifier(await listAccounts(codexHome), identifier);
  // Removing deletes the saved credentials, so a partial match must be confirmed.
  const confirmPartialRemove = action === "remove"
    && matches.length === 1
    && !isExactAccountMatch(matches[0], identifier);
  if (matches.length <= 1 && !confirmPartialRemove) {
    return identifier;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (confirmPartialRemove) {
      throw new Error(`"${identifier}" only partially matches ${accountLabel(matches[0])}. Use the exact email or alias, or re-run in a TTY to confirm.`);
    }
    throw new Error(`Multiple registered accounts match "${identifier}". Re-run in a TTY to choose one.`);
  }

  const verb = action === "remove" ? "Remove" : "Switch";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let selected = matches[0];
    if (matches.length > 1) {
      console.log(`Multiple accounts match "${identifier}":`);
      matches.forEach((account, index) => {
        console.log(`  ${index + 1}. ${accountLabel(account)}`);
      });

      const selection = (await rl.question(`Select account to ${action} [1-${matches.length}] (or q to cancel): `)).trim();
      if (!selection || /^q$/i.test(selection)) {
        throw new Error(`${verb} cancelled.`);
      }
      const selectedIndex = Number.parseInt(selection, 10);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > matches.length) {
        throw new Error(`Invalid selection. Enter a number from 1 to ${matches.length}.`);
      }
      selected = matches[selectedIndex - 1];
    }
    const confirmation = (await rl.question(`${verb === "Remove" ? "Remove" : "Switch to"} ${accountLabel(selected)}? [y/N] `)).trim();
    if (!/^y(es)?$/i.test(confirmation)) {
      throw new Error(`${verb} cancelled.`);
    }
    return selected.account_key;
  } finally {
    rl.close();
  }
}

// Usage comes last because it can wait on the network, and the local status
// shouldn't. A local failure still shows the usage, which needs no SQLite.
async function printStatus() {
  let localError = null;
  try {
    await syncActiveAccountFromCurrentAuth(codexHome);
    console.log(renderStatus(await getStatus({ codexHome })));
    console.log("");
  } catch (error) {
    localError = error;
  }
  console.log(await renderAccountUsage(codexHome));
  console.log("");
  console.log(await renderBackgroundWarm());
  if (localError) {
    throw localError;
  }
}

/** @param {string | undefined} identifier */
async function switchAccount(identifier) {
  await syncActiveAccountFromCurrentAuth(codexHome);
  const resolved = await resolveAccountIdentifier(identifier, "switch");
  const result = await runSwitch({ codexHome, identifier: resolved });
  const account = result.switchedAccount;
  console.log(`Switched account: ${account.email || account.alias || resolved}${account.provider ? ` [${account.provider}]` : ""}`);
  console.log(summarizeSync(result, "Synchronized"));
  if (await restartDaemonForNewLogin() && result.skippedLockedRolloutFiles.length) {
    await resyncSkippedRollouts(result);
  }
}

/** @param {string | undefined} alias */
async function addAccountCommand(alias) {
  // Snapshotting a third-party provider or an API key leaves the login as it
  // is, so the daemon needs no restart.
  if (!await addNeedsLogin(codexHome)) {
    printAddedAccount(await addAccount(codexHome, alias));
    return;
  }

  /** @type {import("./accounts.js").AccountSummary | null} */
  let previous = null;
  const result = await addAccountWithLogin(codexHome, alias, {
    onCurrentSaved(saved) {
      previous = saved;
      if (saved) {
        console.log(`Saved current account: ${saved.email ?? saved.accountKey}`);
      }
      console.log("Opening Codex. Choose how to sign in, then exit Codex to finish adding the account.");
    },
    runCodex: () => runCodexForLogin(codexHome)
  });
  if (result.alreadyRegistered) {
    console.log(`Refreshed already registered account: ${result.email ?? result.accountKey}`);
    console.log("To add a different account, sign out of auth.openai.com in the browser or use a private window.");
  } else {
    printAddedAccount(result);
  }
  // Signing in makes the new login the current one; the saved one is a switch away.
  const saved = /** @type {import("./accounts.js").AccountSummary | null} */ (previous);
  if (saved && saved.accountKey !== result.accountKey) {
    console.log(`Codex now uses this account. To go back: cx switch ${shellArgument(saved.email || saved.alias || saved.accountKey)}`);
  }
  await restartDaemonForNewLogin();
}

const WATCH_POLL_MS = 60 * 1000;

// Sleeps toward a wall-clock target in short steps, since a timer doesn't count
// the time a machine spends suspended. Wakes early when `wakeEarly` says so.
/**
 * @param {number} target ms
 * @param {() => Promise<boolean>} wakeEarly
 */
async function sleepUntil(target, wakeEarly) {
  for (let left = target - Date.now(); left > 0; left = target - Date.now()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, WATCH_POLL_MS)));
    if (await wakeEarly()) {
      return;
    }
  }
}

/** Codex activity, or false when it can't be told. */
async function codexActiveNow() {
  return isCodexActive(codexHome).catch(() => false);
}

/** @param {number} ms */
function localTime(ms) {
  const date = new Date(ms);
  const pad = (/** @type {number} */ value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const WARM_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

async function renderBackgroundWarm() {
  try {
    const { background, pid, log, startFailure } = await backgroundWarmStatus(codexHome);
    if (pid !== null) {
      return `Background warm: running (pid ${pid}), log: ${log}`;
    }
    if (!background) {
      return "Background warm: off (cx warm start turns it on)";
    }
    return startFailure
      ? `Background warm: on but not running; it failed to start at ${localTime(startFailure.at)} (${startFailure.error}). cx warm start tries again`
      : "Background warm: on but not running; the next cx command starts it";
  } catch (error) {
    return `Background warm: unknown (${errorMessage(error)})`;
  }
}

/**
 * @param {string | undefined} action
 * @param {boolean} watch
 */
async function warmCommand(action, watch) {
  if (action !== undefined && (watch || !["start", "stop"].includes(action))) {
    throw new Error(`Usage: ${COMMANDS.warm.usage}`);
  }
  if (action === "start") {
    const result = await startBackgroundWarm(codexHome);
    console.log(result.status === "started"
      ? `cx warm runs in the background (pid ${result.pid}). Log: ${result.log}`
      : `cx warm already runs in the background (pid ${result.pid}). Log: ${result.log}`);
    console.log("Any cx command starts it again after a reboot; cx warm stop turns it off.");
    return;
  }
  if (action === "stop") {
    const result = await stopBackgroundWarm(codexHome);
    console.log(result.status === "stopped" ? `Stopped cx warm (pid ${result.pid}).` : "cx warm was not running.");
    return;
  }
  // Codex runs in a process group of its own, which a Ctrl+C or a stop doesn't
  // reach: end it before exiting, or it may refresh tokens after its warm-up
  // home was recovered.
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.once(signal, () => {
      stopActiveExecs();
      process.exit(watch ? 0 : 128 + (os.constants.signals[signal] ?? 0));
    });
  }
  if (!watch) {
    const results = await warmAccounts(codexHome, { codexActive: await codexActiveNow() });
    console.log(renderWarmResults(results));
    if (warmFailed(results)) {
      process.exitCode = 1;
    }
    return;
  }

  const claim = await claimWatcher(codexHome);
  if (!claim.claimed) {
    throw new Error(`cx warm already runs (pid ${claim.pid}). Stop it first: cx warm stop`);
  }
  // An account whose request failed isn't sent another one for a while, so a
  // revoked login doesn't start Codex on every check.
  /** @type {Map<string, number>} */
  const failedAt = new Map();
  /** @type {Map<string, string>} */
  let lastState = new Map();
  for (;;) {
    let next;
    // While Codex is in use, idle 5-hour windows are started too.
    const codexActive = await codexActiveNow();
    try {
      const results = await warmAccounts(codexHome, {
        codexActive,
        skip: (accountKey) => Date.now() - (failedAt.get(accountKey) ?? -Infinity) < WARM_RETRY_COOLDOWN_MS
      });
      for (const result of results) {
        if (result.attempted && (result.outcome === "failed" || result.outcome === "unconfirmed")) {
          failedAt.set(result.accountKey, Date.now());
        } else if (result.attempted) {
          failedAt.delete(result.accountKey);
        }
      }
      const report = renderWarmChanges(results, lastState);
      lastState = report.state;
      if (report.text) {
        console.log(`[${localTime(Date.now())}]\n${report.text}`);
      }
      next = nextWarmCheck(results, Date.now(), { codexActive });
    } catch (error) {
      console.warn(`[${localTime(Date.now())}] ${errorMessage(error)}`);
      next = Date.now() + 5 * 60 * 1000;
    }
    console.log(`Next check: ${localTime(next)}${codexActive ? "" : ", or as soon as Codex is used"}`);
    // Starting to use Codex is a reason to check at once, for the 5-hour windows.
    await sleepUntil(next, async () => !codexActive && await codexActiveNow());
  }
}

async function listAccountsCommand() {
  await syncActiveAccountFromCurrentAuth(codexHome);
  const accounts = await listAccounts(codexHome);
  if (!accounts.length) {
    console.log("No registered accounts. Run `cx add` first.");
    return;
  }
  const current = await getCurrentAccount(codexHome);
  console.log(renderRegisteredAccounts(accounts, current?.account_key ?? null));
}

/** @param {string | undefined} identifier */
async function removeAccountCommand(identifier) {
  await syncActiveAccountFromCurrentAuth(codexHome);
  const resolved = await resolveAccountIdentifier(identifier, "remove");
  const result = await removeAccount(codexHome, /** @type {string} */ (resolved));
  console.log(`Removed account: ${result.email ?? result.accountKey}`);
}

/** @param {string[]} argv */
function parseCommandLine(argv) {
  try {
    return parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" }, watch: { type: "boolean" } },
      allowPositionals: true,
      strict: true
    });
  } catch (error) {
    // Keep only the first sentence of Node's message, which names the option.
    throw new Error(errorMessage(error).split(". ")[0]);
  }
}

async function main() {
  const { values, positionals } = parseCommandLine(process.argv.slice(2));
  const [name, ...args] = positionals;

  if (values.help || !name || name === "help") {
    printHelp();
    return;
  }

  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!command) {
    throw new Error(`Unknown command: ${name}`);
  }
  if (args.length > command.maxArgs) {
    throw new Error(`Too many arguments. Usage: ${command.usage}`);
  }
  const { help: _help, ...flags } = values;
  const unknownFlag = Object.keys(flags).find((flag) => !command.flags?.includes(flag));
  if (unknownFlag) {
    throw new Error(`Unknown option '--${unknownFlag}' for cx ${name}. Usage: ${command.usage}`);
  }
  if (name !== "warm") {
    await reviveBackgroundWarm(codexHome).catch((error) => {
      console.warn(`Could not start the background cx warm: ${errorMessage(error)}`);
    });
  }
  await command.run(args, flags);
}

// Wrapped errors keep the error that caused them; show it unless the message
// already includes it.
/** @param {unknown} error */
function formatError(error) {
  const lines = [errorMessage(error)];
  let cause = /** @type {{ cause?: unknown }} */ (error)?.cause;
  for (let depth = 0; cause && depth < 5; depth += 1) {
    const message = errorMessage(cause);
    if (!lines.some((line) => line.includes(message))) {
      lines.push(`  Caused by: ${message}`);
    }
    cause = /** @type {{ cause?: unknown }} */ (cause)?.cause;
  }
  return lines.join("\n");
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
