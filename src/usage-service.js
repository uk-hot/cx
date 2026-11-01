import fs from "node:fs/promises";
import path from "node:path";

import {
  accountKeyToFilename,
  parseAuthFile,
  readRegistry,
  resolveAccountsDir,
  resolveAuthPath
} from "./auth-service.js";
import { DEFAULT_PROVIDER } from "./constants.js";
import { ANSI, buildTable, colorEnabled, colorize } from "./terminal-ui.js";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_TIMEOUT_MS = 8000;
const SECONDS_PER_DAY = 86400;
const LOW_QUOTA_PERCENT = 30;
const CRITICAL_QUOTA_PERCENT = 10;

// Usage limits exist only for ChatGPT sign-ins to OpenAI itself: API keys and
// third-party providers have none.
function isOfficialAccount(account) {
  return (account.provider ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER
    && String(account.auth_mode ?? "").toLowerCase() === "chatgpt";
}

async function readAuthData(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

// The logged-in account's newest tokens are in auth.json, where Codex refreshes
// them; its snapshot may be older.
function accessTokenFor(account, liveAuth, snapshotAuth) {
  const authData = parseAuthFile(liveAuth)?.accountKey === account.account_key ? liveAuth : snapshotAuth;
  const parsed = parseAuthFile(authData);
  const accessToken = authData?.tokens?.access_token;
  return parsed?.accountKey === account.account_key && accessToken
    ? { accessToken, accountId: parsed.accountId }
    : null;
}

function toQuota(window) {
  if (!Number.isFinite(window?.used_percent)) {
    return null;
  }
  return {
    remainingPercent: Math.min(100, Math.max(0, 100 - window.used_percent)),
    resetsAt: Number.isFinite(window.reset_at) ? window.reset_at : null
  };
}

// The primary and secondary windows are told apart by length, not by position:
// a plan with a single limit reports it as the primary window.
function parseUsageBody(body) {
  const windows = [body?.rate_limit?.primary_window, body?.rate_limit?.secondary_window];
  const fiveHour = toQuota(windows.find((window) => window?.limit_window_seconds < SECONDS_PER_DAY));
  const weekly = toQuota(windows.find((window) => window?.limit_window_seconds >= SECONDS_PER_DAY));
  if (!fiveHour && !weekly) {
    return null;
  }
  return { plan: typeof body.plan_type === "string" ? body.plan_type : null, fiveHour, weekly };
}

async function fetchUsage(credentials, fetchFn) {
  let response;
  try {
    response = await fetchFn(USAGE_ENDPOINT, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.accessToken}`,
        "ChatGPT-Account-Id": credentials.accountId,
        "User-Agent": "cx"
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS)
    });
  } catch (error) {
    return { error: error?.name === "TimeoutError" ? "timed out" : "unreachable" };
  }
  if (response.status === 401) {
    return { error: "sign-in expired" };
  }
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  const usage = parseUsageBody(await response.json().catch(() => null));
  return usage ?? { error: "unexpected response" };
}

// Live 5h and weekly quota of every official OpenAI account. Tokens are only
// ever read: refresh tokens are single-use, so refreshing one here could sign
// out a running Codex. An account whose access token expired reports that
// instead. One account failing never affects the others.
export async function getAccountUsage(codexHome, { fetchFn = fetch } = {}) {
  const registry = await readRegistry(codexHome);
  const accounts = registry.accounts.filter(isOfficialAccount);
  if (!accounts.length) {
    return [];
  }
  const liveAuth = await readAuthData(resolveAuthPath(codexHome));
  const accountsDir = resolveAccountsDir(codexHome);

  return Promise.all(accounts.map(async (account) => {
    const row = {
      label: account.email ?? account.alias ?? account.account_key,
      active: account.account_key === registry.active_account_key
    };
    const snapshotAuth = await readAuthData(path.join(accountsDir, accountKeyToFilename(account.account_key)));
    const credentials = accessTokenFor(account, liveAuth, snapshotAuth);
    if (!credentials) {
      return { ...row, error: "no saved login" };
    }
    return { ...row, ...await fetchUsage(credentials, fetchFn) };
  }));
}

function formatDuration(seconds) {
  const minutes = Math.ceil(Math.max(0, seconds) / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (minutes < 1440) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`;
}

function formatQuota(quota, nowSeconds) {
  if (!quota) {
    return "-";
  }
  const percent = `${Math.round(quota.remainingPercent)}%`;
  return quota.resetsAt === null
    ? percent
    : `${percent} (resets in ${formatDuration(quota.resetsAt - nowSeconds)})`;
}

function quotaColor(cell) {
  const percent = Number.parseInt(cell, 10);
  if (!Number.isFinite(percent)) {
    return cell === "-" ? null : ANSI.yellow;
  }
  if (percent <= CRITICAL_QUOTA_PERCENT) {
    return ANSI.red;
  }
  return percent <= LOW_QUOTA_PERCENT ? ANSI.yellow : ANSI.green;
}

export function renderUsage(rows, { now = Date.now() } = {}) {
  const title = colorize("ACCOUNT USAGE", ANSI.cyan, colorEnabled());
  if (!rows.length) {
    return `${title}\nNo OpenAI accounts registered.`;
  }
  const nowSeconds = Math.floor(now / 1000);
  const tableRows = rows.map((row) => [
    `${row.active ? "*" : " "} ${row.label}`,
    row.plan ?? "-",
    row.error ?? formatQuota(row.fiveHour, nowSeconds),
    row.error ? "-" : formatQuota(row.weekly, nowSeconds)
  ]);
  return [
    title,
    buildTable(["ACCOUNT", "PLAN", "5H LEFT", "WEEKLY LEFT"], tableRows, {
      cellColor: (index, cell) => (index >= 2 ? quotaColor(cell) : null)
    })
  ].join("\n");
}
