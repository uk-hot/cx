#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import process from "node:process";

import {
  accountDisplayName,
  findAccountsByIdentifier,
  getCurrentAccount,
  isExactAccountMatch,
  listAccounts,
  removeAccount,
  addAccount,
  addAccountWithLogin,
  addNeedsLogin,
  syncActiveAccountFromCurrentAuth,
  useAccount
} from "./auth-service.js";
import { restartCodexDaemon } from "./codex-daemon.js";
import { runCodexForLogin } from "./codex-login.js";
import { defaultCodexHome } from "./constants.js";
import { renderAccountUsage } from "./usage-service.js";

function resolveHome() {
  return defaultCodexHome();
}

function printHelp() {
  console.log(`cx

Usage:
  cx status
  cx switch <email|alias>

  cx add [alias]
  cx list
  cx remove <email|alias>
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const eqIndex = value.indexOf("=");
    if (eqIndex !== -1) {
      flags[value.slice(2, eqIndex)] = value.slice(eqIndex + 1);
      continue;
    }
    const normalizedName = value.slice(2);
    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      flags[normalizedName] = nextValue;
      index += 1;
    } else {
      flags[normalizedName] = true;
    }
  }

  return { positionals, flags };
}

function assertNoExtraPositionals(positionals, maxLength, usage) {
  if (positionals.length <= maxLength) {
    return;
  }
  throw new Error(`Too many arguments. Usage: ${usage}`);
}

function validateFlags(command, flags) {
  const allowedFlagsByCommand = {
    status: new Set(),
    switch: new Set(["account"]),
    add: new Set(["alias"]),
    list: new Set(),
    remove: new Set(["account"])
  };

  const allowedFlags = allowedFlagsByCommand[command];
  if (!allowedFlags) {
    return;
  }

  for (const flagName of Object.keys(flags)) {
    if (flagName === "help") {
      continue;
    }
    if (!allowedFlags.has(flagName)) {
      throw new Error(`Unknown option for ${command}: --${flagName}`);
    }
  }
}

function summarizeSync(result, label) {
  const lines = [
    `${label} provider: ${result.targetProvider}`,
    `Codex home: ${result.codexHome}`,
    `Updated rollout files: ${result.changedSessionFiles}`,
    `Updated SQLite rows: ${result.sqliteRowsUpdated}${result.sqlitePresent ? "" : " (state_5.sqlite not found)"}`
  ];
  if (result.skippedLockedRolloutFiles?.length) {
    const preview = result.skippedLockedRolloutFiles.slice(0, 5).join(", ");
    const extraCount = result.skippedLockedRolloutFiles.length - Math.min(result.skippedLockedRolloutFiles.length, 5);
    lines.push(`Skipped locked rollout files: ${result.skippedLockedRolloutFiles.length}`);
    lines.push(`Locked file(s): ${preview}${extraCount > 0 ? ` (+${extraCount} more)` : ""}`);
  }
  return lines.join("\n");
}

function printAddedAccount(result) {
  console.log(`Added account: ${result.email ?? result.accountKey}${result.alias ? ` (alias: ${result.alias})` : ""}`);
}

// Runs after the login in ~/.codex changed. The command already succeeded, so a
// failed restart is a warning with the manual fix, not an error. Returns whether
// the daemon was restarted.
async function restartDaemonForNewLogin() {
  let result;
  try {
    result = await restartCodexDaemon(resolveHome());
  } catch (error) {
    result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
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
async function resyncSkippedRollouts(switchResult) {
  try {
    const { runSync } = await loadServiceModule();
    const result = await runSync({ codexHome: resolveHome(), provider: switchResult.targetProvider });
    console.log(summarizeSync(result, "Re-synchronized"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not sync the rollout files skipped by the switch (${message}). Run cx switch again to sync them.`);
  }
}

function accountLabel(account) {
  const providerSuffix = account.provider ? ` [${account.provider}]` : "";
  return `${accountDisplayName(account)}${providerSuffix}`;
}

function renderRegisteredAccounts(accounts, activeKey) {
  const labelWidth = Math.max(...accounts.map((account) => accountDisplayName(account).length), 0);

  const lines = [`Registered accounts (${accounts.length}):`];
  for (const account of accounts) {
    const isActive = account.account_key === activeKey;
    const provider = account.provider ?? "-";
    lines.push(`${isActive ? "*" : " "} ${accountDisplayName(account).padEnd(labelWidth)}  ${provider}${isActive ? "  (active)" : ""}`);
  }

  return lines.join("\n");
}

async function resolveAccountIdentifier(codexHome, identifier, action) {
  if (!identifier) {
    return identifier;
  }

  const accounts = await listAccounts(codexHome);
  const matches = findAccountsByIdentifier(accounts, identifier);
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

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    let selected = matches[0];
    if (matches.length > 1) {
      console.log(`Multiple accounts match "${identifier}":`);
      matches.forEach((account, index) => {
        console.log(`  ${index + 1}. ${accountLabel(account)}`);
      });

      const selection = (await rl.question(`Select account to ${action} [1-${matches.length}] (or q to cancel): `)).trim();
      if (!selection || /^q$/i.test(selection)) {
        throw new Error(`${action === "remove" ? "Remove" : "Switch"} cancelled.`);
      }

      const selectedIndex = Number.parseInt(selection, 10);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > matches.length) {
        throw new Error(`Invalid selection. Enter a number from 1 to ${matches.length}.`);
      }

      selected = matches[selectedIndex - 1];
    }
    const confirmPrompt = action === "remove"
      ? `Remove ${accountLabel(selected)}? [y/N] `
      : `Switch to ${accountLabel(selected)}? [y/N] `;
    const confirmation = (await rl.question(confirmPrompt)).trim();
    if (!/^y(es)?$/i.test(confirmation)) {
      throw new Error(`${action === "remove" ? "Remove" : "Switch"} cancelled.`);
    }

    return selected.account_key;
  } finally {
    rl.close();
  }
}

async function loadServiceModule() {
  return import("./service.js");
}

// Usage comes last because it can wait on the network, and the local status
// shouldn't. A local failure still shows the usage, which needs no SQLite.
async function printStatus(codexHome) {
  let localError = null;
  try {
    await syncActiveAccountFromCurrentAuth(codexHome);
    const { getStatus, renderStatus } = await loadServiceModule();
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

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];

  if (flags.help) {
    printHelp();
    return;
  }

  if (!command || command === "help") {
    const unknownRootFlag = Object.keys(flags)[0];
    if (unknownRootFlag) {
      throw new Error(`Unknown option: --${unknownRootFlag}`);
    }
    printHelp();
    return;
  }

  if (flags.keep !== undefined) {
    throw new Error("The --keep option has been removed because backup pruning is no longer supported.");
  }
  if (flags["codex-home"] !== undefined) {
    throw new Error("The --codex-home option has been removed. Codex home is fixed to ~/.codex.");
  }

  validateFlags(command, flags);

  if (command === "status") {
    assertNoExtraPositionals(positionals, 1, "cx status");
    await printStatus(resolveHome());
    return;
  }

  if (command === "switch") {
    assertNoExtraPositionals(positionals, 2, "cx switch <email|alias>");
    await syncActiveAccountFromCurrentAuth(resolveHome());
    const { runSwitch } = await loadServiceModule();
    const identifier = await resolveAccountIdentifier(resolveHome(), positionals[1] ?? flags.account, "switch");
    const result = await runSwitch({
      codexHome: resolveHome(),
      identifier,
      useAccountFn: useAccount
    });
    const acct = result.switchedAccount;
    const label = acct?.email || acct?.alias || identifier;
    console.log(`Switched account: ${label}${acct?.provider ? ` [${acct.provider}]` : ""}`);
    console.log(summarizeSync(result, "Synchronized"));
    if (await restartDaemonForNewLogin() && result.skippedLockedRolloutFiles?.length) {
      await resyncSkippedRollouts(result);
    }
    return;
  }

  if (command === "add") {
    assertNoExtraPositionals(positionals, 2, "cx add [alias]");
    const alias = positionals[1] ?? flags.alias;

    // Snapshotting a third-party provider or an API key leaves the login as it
    // is, so the daemon needs no restart.
    if (!await addNeedsLogin(resolveHome())) {
      printAddedAccount(await addAccount(resolveHome(), alias));
      return;
    }

    const result = await addAccountWithLogin(resolveHome(), alias, {
      onCurrentSaved(saved) {
        if (saved) {
          console.log(`Saved current account: ${saved.email ?? saved.accountKey}`);
        }
        console.log("Opening Codex. Choose how to sign in, then exit Codex to finish adding the account.");
      },
      runCodex: () => runCodexForLogin(resolveHome())
    });
    if (result.alreadyRegistered) {
      console.log(`Refreshed already registered account: ${result.email ?? result.accountKey}`);
      console.log("To add a different account, sign out of auth.openai.com in the browser or use a private window.");
    } else {
      printAddedAccount(result);
    }
    await restartDaemonForNewLogin();
    return;
  }

  if (command === "list") {
    assertNoExtraPositionals(positionals, 1, "cx list");
    await syncActiveAccountFromCurrentAuth(resolveHome());
    const accounts = await listAccounts(resolveHome());
    if (!accounts.length) {
      console.log("No registered accounts. Run `cx add` first.");
      return;
    }
    const current = await getCurrentAccount(resolveHome());
    console.log(renderRegisteredAccounts(accounts, current?.account_key ?? null));
    return;
  }

  if (command === "remove") {
    assertNoExtraPositionals(positionals, 2, "cx remove <email|alias>");
    await syncActiveAccountFromCurrentAuth(resolveHome());
    const identifier = await resolveAccountIdentifier(resolveHome(), positionals[1] ?? flags.account, "remove");
    const result = await removeAccount(resolveHome(), identifier);
    console.log(`Removed account: ${result.email ?? result.accountKey}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
