#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import process from "node:process";

import {
  findAccountsByIdentifier,
  getCurrentAccount,
  listAccounts,
  removeAccount,
  saveAccount,
  syncActiveAccountFromCurrentAuth,
  useAccount
} from "./auth-service.js";
import { defaultCodexHome } from "./constants.js";

function resolveHome() {
  return defaultCodexHome();
}

function printHelp() {
  console.log(`cx

Usage:
  cx status
  cx switch <email|alias>

  cx save [alias]
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
    const [flagName, inlineValue] = value.split("=", 2);
    const normalizedName = flagName.slice(2);
    if (inlineValue !== undefined) {
      flags[normalizedName] = inlineValue;
      continue;
    }
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
    save: new Set(["alias"]),
    list: new Set(),
    remove: new Set(["account"]),
    usage: new Set()
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

function accountLabel(account) {
  const primary = account.email ?? account.alias ?? account.account_key;
  const providerSuffix = account.provider ? ` [${account.provider}]` : "";
  return `${primary}${providerSuffix}`;
}

async function resolveAccountIdentifier(codexHome, identifier, action) {
  if (!identifier) {
    return identifier;
  }

  const accounts = await listAccounts(codexHome);
  const matches = findAccountsByIdentifier(accounts, identifier);
  if (matches.length <= 1) {
    return identifier;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Multiple saved accounts match "${identifier}". Re-run in a TTY to choose one.`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
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

    const selected = matches[selectedIndex - 1];
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

async function loadUsageModule() {
  return import("./usage-service.js");
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
    await syncActiveAccountFromCurrentAuth(resolveHome());
    const { getStatus, renderStatus } = await loadServiceModule();
    const status = await getStatus({ codexHome: resolveHome() });
    console.log(renderStatus(status));
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
    const label = acct?.email ?? acct?.alias ?? identifier;
    console.log(`Switched account: ${label}${acct?.provider ? ` [${acct.provider}]` : ""}`);
    console.log(summarizeSync(result, "Synchronized"));
    return;
  }

  if (command === "save") {
    assertNoExtraPositionals(positionals, 2, "cx save [alias]");
    const alias = positionals[1] ?? flags.alias;
    const result = await saveAccount(resolveHome(), alias);
    console.log(`Saved account: ${result.email ?? result.accountKey}${result.alias ? ` (alias: ${result.alias})` : ""}`);
    return;
  }

  if (command === "list") {
    assertNoExtraPositionals(positionals, 1, "cx list");
    await syncActiveAccountFromCurrentAuth(resolveHome());
    const { renderAccountsTable, refreshChatgptUsageFromApi } = await loadUsageModule();
    await refreshChatgptUsageFromApi(resolveHome());
    const accounts = await listAccounts(resolveHome());
    const current = await getCurrentAccount(resolveHome());
    if (!accounts.length) {
      console.log("No saved accounts. Run `cx save` first.");
      return;
    }
    console.log(renderAccountsTable(accounts, current?.account_key ?? null));
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

  if (command === "usage") {
    assertNoExtraPositionals(positionals, 1, "cx usage");
    await syncActiveAccountFromCurrentAuth(resolveHome());
    const { formatUsage, loadUsageDisplayState } = await loadUsageModule();
    const usageState = await loadUsageDisplayState(resolveHome());
    console.log(formatUsage(usageState));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
