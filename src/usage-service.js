import fs from "node:fs/promises";
import path from "node:path";

import {
  accountKeyToFilename,
  readRegistry,
  resolveAccountsDir,
  writeRegistry
} from "./auth-service.js";
import { ANSI, colorEnabled, padCell } from "./terminal-ui.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LIST_HEADERS = ["ACCOUNT", "PROVIDER", "PLAN", "5H USAGE", "WEEKLY USAGE", "LAST ACTIVITY"];
const RATE_WINDOW_5H_MINUTES = 300;
const RATE_WINDOW_WEEKLY_MINUTES = 10080;
const USAGE_API_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_API_TIMEOUT_MS = 5000;

function normalizedEmail(value) {
  return typeof value === "string" && value.length ? value.toLowerCase() : null;
}

function resolvePlan(account) {
  return account?.plan ?? account?.last_usage?.plan_type ?? null;
}

function planSortRank(plan) {
  switch (plan ?? "unknown") {
    case "team":
    case "business":
    case "enterprise":
    case "edu":
      return 0;
    case "free":
    case "plus":
    case "pro":
      return 1;
    default:
      return 2;
  }
}

function isChatgptAccount(account) {
  if (!account || typeof account !== "object") {
    return false;
  }
  if (account.auth_mode) {
    return account.auth_mode === "chatgpt";
  }
  return Boolean(account.chatgpt_account_id && account.chatgpt_user_id);
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePlanType(planType) {
  if (typeof planType !== "string" || planType.length === 0) {
    return null;
  }
  const normalized = planType.toLowerCase();
  return [
    "free",
    "plus",
    "pro",
    "team",
    "business",
    "enterprise",
    "edu"
  ].includes(normalized)
    ? normalized
    : "unknown";
}

function ceilMinutes(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return null;
  }
  return Math.trunc((seconds + 59) / 60);
}

function extractApiUsageSnapshot(body) {
  if (!body || typeof body !== "object") {
    return null;
  }

  const primaryWindow = body.rate_limit?.primary_window;
  const secondaryWindow = body.rate_limit?.secondary_window;
  const primary = primaryWindow && typeof primaryWindow === "object"
    ? {
        used_percent: toNumber(primaryWindow.used_percent),
        window_minutes: ceilMinutes(primaryWindow.limit_window_seconds),
        resets_at: Number.isInteger(primaryWindow.reset_at) ? primaryWindow.reset_at : null
      }
    : null;
  const secondary = secondaryWindow && typeof secondaryWindow === "object"
    ? {
        used_percent: toNumber(secondaryWindow.used_percent),
        window_minutes: ceilMinutes(secondaryWindow.limit_window_seconds),
        resets_at: Number.isInteger(secondaryWindow.reset_at) ? secondaryWindow.reset_at : null
      }
    : null;

  const normalizedPrimary = primary?.used_percent === null ? null : primary;
  const normalizedSecondary = secondary?.used_percent === null ? null : secondary;
  if (!normalizedPrimary && !normalizedSecondary) {
    return null;
  }

  return {
    primary: normalizedPrimary,
    secondary: normalizedSecondary,
    credits: body.credits ?? null,
    plan_type: normalizePlanType(body.plan_type)
  };
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function remainingPercent(usedPercent) {
  const remaining = 100 - Number(usedPercent ?? 0);
  if (remaining <= 0) {
    return 0;
  }
  if (remaining >= 100) {
    return 100;
  }
  return Math.floor(remaining);
}

function sameLocalDay(left, right) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function formatClock(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatResetParts(resetAtSeconds, now = new Date()) {
  const resetDate = new Date(resetAtSeconds * 1000);
  return {
    time: formatClock(resetDate),
    date: `${resetDate.getDate()} ${MONTH_NAMES[resetDate.getMonth()]}`,
    sameDay: sameLocalDay(resetDate, now)
  };
}

function resolveRateWindow(usage, minutes, fallbackPrimary) {
  if (!usage) {
    return null;
  }
  if (usage.primary?.window_minutes === minutes) {
    return usage.primary;
  }
  if (usage.secondary?.window_minutes === minutes) {
    return usage.secondary;
  }
  return fallbackPrimary ? usage.primary ?? null : usage.secondary ?? null;
}

function formatRateLimitFull(window) {
  if (!window?.resets_at) {
    return "-";
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds >= window.resets_at) {
    return "100%";
  }

  const remaining = remainingPercent(window.used_percent);
  const parts = formatResetParts(window.resets_at);
  return parts.sameDay
    ? `${remaining}% (${parts.time})`
    : `${remaining}% (${parts.time} on ${parts.date})`;
}

function formatRateLimitUi(window, width) {
  if (!window?.resets_at) {
    return "-";
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds >= window.resets_at) {
    return "100%";
  }

  const remaining = remainingPercent(window.used_percent);
  const parts = formatResetParts(window.resets_at);
  const candidates = parts.sameDay
    ? [`${remaining}% (${parts.time})`, `${remaining}%`]
    : [
        `${remaining}% (${parts.time} on ${parts.date})`,
        `${remaining}% (${parts.date})`,
        `${remaining}% (${parts.time})`,
        `${remaining}%`
      ];

  return candidates.find((candidate) => width === 0 || candidate.length <= width) ?? candidates.at(-1);
}

function formatRelativeTime(timestampSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!timestampSeconds || timestampSeconds <= 0) {
    return "-";
  }
  let delta = nowSeconds - timestampSeconds;
  if (delta < 0) {
    delta = 0;
  }
  if (delta < 60) {
    return "Now";
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m ago`;
  }
  if (delta < 86400) {
    return `${Math.floor(delta / 3600)}h ago`;
  }
  return `${Math.floor(delta / 86400)}d ago`;
}

function createEmptyCells() {
  return {
    provider: "",
    plan: "",
    usage5h: "",
    usageWeekly: "",
    lastActivity: ""
  };
}

function sortAccountsForDisplay(accounts, activeAccountKey) {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => {
      const leftEmail = normalizedEmail(left.account.email) ?? `~${left.account.account_key}`;
      const rightEmail = normalizedEmail(right.account.email) ?? `~${right.account.account_key}`;
      if (leftEmail !== rightEmail) {
        return leftEmail.localeCompare(rightEmail);
      }

      const leftActive = left.account.account_key === activeAccountKey;
      const rightActive = right.account.account_key === activeAccountKey;
      if (leftActive !== rightActive) {
        return leftActive ? -1 : 1;
      }

      const leftPlan = resolvePlan(left.account);
      const rightPlan = resolvePlan(right.account);
      const leftRank = planSortRank(leftPlan);
      const rightRank = planSortRank(rightPlan);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      const leftPlanLabel = leftPlan ?? "-";
      const rightPlanLabel = rightPlan ?? "-";
      if (leftPlanLabel !== rightPlanLabel) {
        return leftPlanLabel.localeCompare(rightPlanLabel);
      }

      return left.account.account_key.localeCompare(right.account.account_key);
    })
    .map(({ index }) => index);
}

function groupedFallbackLabel(account) {
  return resolvePlan(account) ?? account.provider ?? account.account_key;
}

function buildAccountLabel(account, { grouped = false } = {}) {
  const alias = typeof account.alias === "string" && account.alias.length ? account.alias : null;
  const accountName = typeof account.account_name === "string" && account.account_name.length ? account.account_name : null;

  if (!grouped && account.email) {
    return account.email;
  }
  if (alias && accountName) {
    return `${alias} (${accountName})`;
  }
  if (alias) {
    return alias;
  }
  if (accountName) {
    return accountName;
  }
  return groupedFallbackLabel(account);
}

function disambiguateGroupLabels(groupAccounts) {
  const counts = new Map();
  return groupAccounts.map((account) => {
    const baseLabel = buildAccountLabel(account, { grouped: true });
    const nextIndex = (counts.get(baseLabel) ?? 0) + 1;
    counts.set(baseLabel, nextIndex);
    if (nextIndex === 1 && groupAccounts.filter((candidate) => buildAccountLabel(candidate, { grouped: true }) === baseLabel).length === 1) {
      return baseLabel;
    }
    return `${baseLabel} #${nextIndex}`;
  });
}

function buildDisplayRows(accounts, activeAccountKey) {
  const orderedIndices = sortAccountsForDisplay(accounts, activeAccountKey);
  const rows = [];

  for (let cursor = 0; cursor < orderedIndices.length;) {
    const currentIndex = orderedIndices[cursor];
    const currentEmail = normalizedEmail(accounts[currentIndex].email);

    if (!currentEmail) {
      rows.push({
        type: "account",
        account: accounts[currentIndex],
        label: buildAccountLabel(accounts[currentIndex]),
        depth: 0,
        isActive: accounts[currentIndex].account_key === activeAccountKey
      });
      cursor += 1;
      continue;
    }

    const groupIndices = [];
    while (cursor < orderedIndices.length) {
      const candidateIndex = orderedIndices[cursor];
      if (normalizedEmail(accounts[candidateIndex].email) !== currentEmail) {
        break;
      }
      groupIndices.push(candidateIndex);
      cursor += 1;
    }

    if (groupIndices.length === 1) {
      const account = accounts[groupIndices[0]];
      rows.push({
        type: "account",
        account,
        label: buildAccountLabel(account),
        depth: 0,
        isActive: account.account_key === activeAccountKey
      });
      continue;
    }

    rows.push({
      type: "header",
      label: accounts[groupIndices[0]].email
    });

    const groupAccounts = groupIndices.map((index) => accounts[index]);
    const groupLabels = disambiguateGroupLabels(groupAccounts);
    for (let index = 0; index < groupAccounts.length; index += 1) {
      const account = groupAccounts[index];
      rows.push({
        type: "account",
        account,
        label: groupLabels[index],
        depth: 1,
        isActive: account.account_key === activeAccountKey
      });
    }
  }

  return rows;
}

function truncateCell(value, width) {
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return ".".repeat(width);
  }
  return `${value.slice(0, width - 3)}...`;
}

function totalListWidth(widths) {
  return 2 + widths.reduce((sum, width) => sum + width, 0) + 2 * (widths.length - 1);
}

function adjustListWidths(widths) {
  if (!process.stdout.isTTY || !Number.isInteger(process.stdout.columns) || process.stdout.columns <= 0) {
    return widths;
  }

  const nextWidths = [...widths];
  const minWidths = [10, 8, 4, 1, 1, 4];
  let overflow = totalListWidth(nextWidths) - process.stdout.columns;
  if (overflow <= 0) {
    return nextWidths;
  }

  for (const columnIndex of [0, 1, 2, 3, 4, 5]) {
    if (overflow <= 0) {
      break;
    }
    const reducible = nextWidths[columnIndex] - minWidths[columnIndex];
    if (reducible <= 0) {
      continue;
    }
    const reduceBy = Math.min(reducible, overflow);
    nextWidths[columnIndex] -= reduceBy;
    overflow -= reduceBy;
  }

  return nextWidths;
}

function formatAccountCells(account, widths) {
  const rate5h = formatRateLimitUi(resolveRateWindow(account.last_usage, RATE_WINDOW_5H_MINUTES, true), widths[3]);
  const rateWeekly = formatRateLimitUi(resolveRateWindow(account.last_usage, RATE_WINDOW_WEEKLY_MINUTES, false), widths[4]);
  return {
    provider: account.provider ?? "-",
    plan: resolvePlan(account) ?? "-",
    usage5h: rate5h,
    usageWeekly: rateWeekly,
    lastActivity: formatRelativeTime(account.last_usage_at)
  };
}

export function renderAccountsTable(accounts, activeAccountKey, options = {}) {
  const filteredAccounts = options.onlyActive
    ? accounts.filter((account) => account.account_key === activeAccountKey)
    : [...accounts];

  if (!filteredAccounts.length) {
    return "";
  }

  const rows = buildDisplayRows(filteredAccounts, activeAccountKey);
  const widths = [...LIST_HEADERS.map((header) => header.length)];

  for (const row of rows) {
    if (row.type !== "account") {
      widths[0] = Math.max(widths[0], row.label.length);
      continue;
    }
    const cells = formatAccountCells(row.account, widths);
    widths[0] = Math.max(widths[0], row.label.length + row.depth * 2);
    widths[1] = Math.max(widths[1], cells.provider.length);
    widths[2] = Math.max(widths[2], cells.plan.length);
    widths[3] = Math.max(widths[3], formatRateLimitFull(resolveRateWindow(row.account.last_usage, RATE_WINDOW_5H_MINUTES, true)).length);
    widths[4] = Math.max(widths[4], formatRateLimitFull(resolveRateWindow(row.account.last_usage, RATE_WINDOW_WEEKLY_MINUTES, false)).length);
    widths[5] = Math.max(widths[5], cells.lastActivity.length);
  }

  const finalWidths = adjustListWidths(widths);
  const useColor = colorEnabled();
  const lines = [];

  const headerCells = LIST_HEADERS.map((header, index) => padCell(truncateCell(header, finalWidths[index]), finalWidths[index]));
  if (useColor) {
    lines.push(`${ANSI.dim}  ${headerCells.join("  ")}${ANSI.reset}`);
    lines.push(`${ANSI.dim}${"-".repeat(totalListWidth(finalWidths))}${ANSI.reset}`);
  } else {
    lines.push(`  ${headerCells.join("  ")}`);
    lines.push("-".repeat(totalListWidth(finalWidths)));
  }

  for (const row of rows) {
    if (row.type === "header") {
      const headerLabel = padCell(truncateCell(row.label, finalWidths[0]), finalWidths[0]);
      lines.push(useColor ? `${ANSI.dim}  ${headerLabel}${ANSI.reset}` : `  ${headerLabel}`);
      continue;
    }

    const indent = " ".repeat(Math.min(finalWidths[0], row.depth * 2));
    const labelWidth = Math.max(0, finalWidths[0] - indent.length);
    const cells = formatAccountCells(row.account, finalWidths);
    const accountCell = `${indent}${padCell(truncateCell(row.label, labelWidth), labelWidth)}`;
    const renderedCells = [
      accountCell,
      padCell(truncateCell(cells.provider, finalWidths[1]), finalWidths[1]),
      padCell(truncateCell(cells.plan, finalWidths[2]), finalWidths[2]),
      padCell(truncateCell(cells.usage5h, finalWidths[3]), finalWidths[3]),
      padCell(truncateCell(cells.usageWeekly, finalWidths[4]), finalWidths[4]),
      padCell(truncateCell(cells.lastActivity, finalWidths[5]), finalWidths[5])
    ];
    const line = `${row.isActive ? "* " : "  "}${renderedCells.join("  ")}`;
    if (useColor && row.isActive) {
      lines.push(`${ANSI.green}${line}${ANSI.reset}`);
    } else {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

function buildUsageNote(state) {
  const activeAccount = state.activeAccount ?? state.currentAccount ?? null;
  if (!activeAccount) {
    return "No active account. Run `cx save` or `cx switch` first.";
  }
  if (!state.accounts?.length) {
    return "No saved ChatGPT/OAuth accounts.";
  }
  if (!isChatgptAccount(activeAccount)) {
    return "Current active account is not ChatGPT/OAuth. Showing saved usage for ChatGPT/OAuth accounts.";
  }
  if (!state.accounts.some((account) => account.last_usage?.primary || account.last_usage?.secondary)) {
    return "No usage data available yet. Switch to a ChatGPT/OAuth account and start a Codex session first.";
  }
  return "";
}

export function formatUsage(state) {
  const table = state.accounts?.length
    ? renderAccountsTable(state.accounts, state.visibleActiveAccountKey ?? null)
    : "";
  const note = buildUsageNote(state);
  if (table && note) {
    return `${table}\n\n${note}`;
  }
  return table || note;
}

async function readChatgptAuthContext(codexHome, account) {
  const authSnapshotPath = path.join(resolveAccountsDir(codexHome), accountKeyToFilename(account.account_key));
  let data;
  try {
    data = JSON.parse(await fs.readFile(authSnapshotPath, "utf8"));
  } catch {
    return null;
  }

  const authMode = data?.auth_mode ?? "chatgpt";
  if (authMode !== "chatgpt") {
    return null;
  }
  const accessToken = data?.tokens?.access_token;
  const accountId = data?.tokens?.account_id ?? account.chatgpt_account_id ?? null;
  if (!accessToken || !accountId) {
    return null;
  }
  return { accessToken, accountId };
}

async function fetchUsageForAccount(codexHome, account, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    return { snapshot: null, statusCode: null, missingAuth: true };
  }

  const authContext = await readChatgptAuthContext(codexHome, account);
  if (!authContext) {
    return { snapshot: null, statusCode: null, missingAuth: true };
  }

  try {
    const response = await fetchImpl(USAGE_API_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authContext.accessToken}`,
        "ChatGPT-Account-Id": authContext.accountId,
        "User-Agent": "cx"
      },
      signal: AbortSignal.timeout(USAGE_API_TIMEOUT_MS)
    });

    const bodyText = await response.text();
    if (!bodyText) {
      return { snapshot: null, statusCode: response.status, missingAuth: false };
    }
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return { snapshot: null, statusCode: response.status, missingAuth: false };
    }
    return {
      snapshot: extractApiUsageSnapshot(body),
      statusCode: response.status,
      missingAuth: false
    };
  } catch {
    return { snapshot: null, statusCode: null, missingAuth: false };
  }
}

export async function refreshChatgptUsageFromApi(codexHome, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const registry = await readRegistry(codexHome);
  let updated = false;
  const now = Math.floor(Date.now() / 1000);

  for (const account of registry.accounts) {
    if (!isChatgptAccount(account)) {
      continue;
    }

    const result = await fetchUsageForAccount(codexHome, account, fetchImpl);
    if (!result.snapshot) {
      continue;
    }

    const usageChanged = !snapshotsEqual(account.last_usage, result.snapshot);
    const timestampChanged = account.last_usage_at !== now;
    if (!usageChanged && !timestampChanged) {
      continue;
    }

    if (usageChanged) {
      account.last_usage = result.snapshot;
    }
    account.last_usage_at = now;
    updated = true;
  }

  if (updated) {
    await writeRegistry(codexHome, registry);
  }

  return {
    updated,
    registry
  };
}

export async function loadUsageDisplayState(codexHome, options = {}) {
  await refreshChatgptUsageFromApi(codexHome, options);
  const registry = await readRegistry(codexHome);
  const activeAccount = registry.active_account_key
    ? registry.accounts.find((account) => account.account_key === registry.active_account_key) ?? null
    : null;
  const chatgptAccounts = registry.accounts.filter((account) => isChatgptAccount(account));
  const visibleActiveAccountKey = chatgptAccounts.some((account) => account.account_key === registry.active_account_key)
    ? registry.active_account_key
    : null;

  return {
    activeAccount,
    currentAccount: activeAccount,
    accounts: chatgptAccounts,
    visibleActiveAccountKey,
    usageSupported: Boolean(activeAccount && isChatgptAccount(activeAccount)),
    rateLimits: visibleActiveAccountKey
      ? chatgptAccounts.find((account) => account.account_key === visibleActiveAccountKey)?.last_usage ?? null
      : null
  };
}
