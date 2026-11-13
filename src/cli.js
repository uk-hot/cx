#!/usr/bin/env node

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

/** @typedef {import("./registry.js").Account} Account */
/** @typedef {import("./service.js").SyncResult} SyncResult */

const codexHome = defaultCodexHome();

/**
 * @typedef {object} Command
 * @property {string} usage
 * @property {string[]} summary help text, one entry per line
 * @property {number} maxArgs
 * @property {(args: string[]) => Promise<void>} run
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
      options: { help: { type: "boolean", short: "h" } },
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
  await command.run(args);
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
