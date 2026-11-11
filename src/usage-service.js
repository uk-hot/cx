import fs from "node:fs/promises";
import path from "node:path";

import {
  accountDisplayName,
  accountKeyToFilename,
  decodeJwtPayload,
  parseAuthFile,
  readRegistry,
  resolveAccountsDir,
  resolveAuthPath
} from "./auth-service.js";
import { DEFAULT_PROVIDER } from "./constants.js";
import { ANSI, buildTable, colorEnabled, colorize, shellArgument } from "./terminal-ui.js";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_TIMEOUT_MS = 8000;
const FIVE_HOUR_WINDOW_SECONDS = 18000;
const WEEKLY_WINDOW_SECONDS = 604800;
const LOW_QUOTA_PERCENT = 30;
const CRITICAL_QUOTA_PERCENT = 10;
const FIVE_HOUR_COLUMN = 2;
const WEEKLY_COLUMN = 3;
const SIGN_IN_EXPIRED = "sign-in expired";
const SIGNED_OUT = "signed out";
const NO_SAVED_LOGIN = "no saved login";

// Usage limits exist only for ChatGPT sign-ins to OpenAI itself: API keys and
// third-party providers have none.
function isOfficialAccount(account) {
  return typeof account?.account_key === "string"
    && (account.provider ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER
    && String(account.auth_mode ?? "").toLowerCase() === "chatgpt";
}

async function readAuthData(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function credentialsFor(account, authData) {
  const parsed = parseAuthFile(authData);
  const accessToken = authData?.tokens?.access_token;
  if (parsed?.accountKey !== account.account_key || typeof accessToken !== "string") {
    return null;
  }
  const exp = decodeJwtPayload(accessToken)?.exp;
  return { accessToken, accountId: parsed.accountId, expiresAt: Number.isFinite(exp) ? exp : null };
}

function toQuota(window) {
  if (!Number.isFinite(window?.used_percent)) {
    return null;
  }
  return {
    remainingPercent: Math.min(100, Math.max(0, 100 - window.used_percent)),
    resetsAt: Number.isFinite(window.reset_at) ? window.reset_at : null,
    windowSeconds: Number.isFinite(window.limit_window_seconds) ? window.limit_window_seconds : null
  };
}

// A null rate_limit is a plan without limits. Anything else that doesn't have
// the known fields means the undocumented endpoint changed.
function usageWindows(rateLimit) {
  if (rateLimit === null) {
    return [];
  }
  if (typeof rateLimit !== "object" || !("primary_window" in rateLimit || "secondary_window" in rateLimit)) {
    return null;
  }
  return [rateLimit.primary_window, rateLimit.secondary_window].filter(Boolean);
}

// Windows are matched by length, not position: a plan with a single limit
// reports it as the primary window. One that is neither 5h nor weekly is kept
// apart instead of being shown under the wrong heading.
function parseUsageBody(body) {
  const windows = usageWindows(body?.rate_limit);
  const quotas = windows?.map(toQuota);
  if (!quotas || quotas.includes(null)) {
    return null;
  }
  const fiveHour = quotas.find((quota) => quota.windowSeconds === FIVE_HOUR_WINDOW_SECONDS) ?? null;
  const weekly = quotas.find((quota) => quota.windowSeconds === WEEKLY_WINDOW_SECONDS) ?? null;
  return {
    plan: typeof body.plan_type === "string" ? body.plan_type : null,
    fiveHour,
    weekly,
    other: quotas.filter((quota) => quota !== fiveHour && quota !== weekly)
  };
}

// A token rejected before it expires was revoked (by `codex logout`, a sign-in
// that replaced it, or OpenAI), which as a rule takes its refresh token with it,
// so signing in again is what helps. An expired one Codex can usually renew.
function rejectedTokenError(credentials, nowSeconds) {
  return credentials.expiresAt !== null && credentials.expiresAt > nowSeconds
    ? SIGNED_OUT
    : SIGN_IN_EXPIRED;
}

async function fetchUsage(credentials, fetchFn, nowSeconds) {
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
    return { error: rejectedTokenError(credentials, nowSeconds) };
  }
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  const usage = parseUsageBody(await response.json().catch(() => null));
  return usage ?? { error: "unexpected response" };
}

// Node's built-in fetch ignores the proxy variables, so a network that reaches
// chatgpt.com only through a proxy needs undici's own. Loaded on demand because
// only this request uses it. It has to be closed: a timed-out request leaves a
// connection to an unresponsive proxy open, which keeps the process alive.
async function createProxyAwareTransport() {
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new EnvHttpProxyAgent();
  return {
    fetchFn: (url, init) => undiciFetch(url, { ...init, dispatcher }),
    close: () => dispatcher.destroy()
  };
}

// Live 5h and weekly quota of every official OpenAI account. Tokens are only
// ever read: refresh tokens are single-use, so refreshing one here could sign
// out a running Codex. An account whose token is rejected reports whether it
// expired or was signed out instead. One account failing never affects the others.
export async function getAccountUsage(codexHome, { fetchFn, now = Date.now() } = {}) {
  const registry = await readRegistry(codexHome);
  const accounts = registry.accounts.filter(isOfficialAccount);
  if (!accounts.length) {
    return [];
  }
  const transport = fetchFn ? { fetchFn } : await createProxyAwareTransport();
  // The logged-in account's newest tokens are in auth.json, where Codex
  // refreshes them; its snapshot may be older.
  const liveAuth = await readAuthData(resolveAuthPath(codexHome));
  const liveAccountKey = parseAuthFile(liveAuth)?.accountKey ?? null;
  const accountsDir = resolveAccountsDir(codexHome);

  try {
    return await Promise.all(accounts.map(async (account) => {
      const row = {
        label: accountDisplayName(account),
        // The registry alone goes stale when Codex is logged in to a login cx
        // doesn't know, and auth.json alone can't tell that a third-party
        // provider is in use.
        active: account.account_key === liveAccountKey && account.account_key === registry.active_account_key
      };
      const authData = account.account_key === liveAccountKey
        ? liveAuth
        : await readAuthData(path.join(accountsDir, accountKeyToFilename(account.account_key)));
      const credentials = credentialsFor(account, authData);
      if (!credentials) {
        return { ...row, error: NO_SAVED_LOGIN };
      }
      return { ...row, ...await fetchUsage(credentials, transport.fetchFn, Math.floor(now / 1000)) };
    }));
  } finally {
    await transport.close?.();
  }
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

function formatWindowLength(seconds) {
  if (seconds === null) {
    return "unknown window";
  }
  if (seconds % 86400 === 0) {
    return `${seconds / 86400}d`;
  }
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : `${Math.ceil(seconds / 60)}m`;
}

function formatOtherQuotas(quotas, nowSeconds) {
  if (!quotas?.length) {
    return "-";
  }
  return quotas
    .map((quota) => `${formatWindowLength(quota.windowSeconds)}: ${formatQuota(quota, nowSeconds)}`)
    .join(", ");
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

// What to run for an account that can't be read because of its sign-in. `cx
// add` signing in to a registered account replaces its saved login.
function signInHint(row) {
  const signInAgain = `cx add, then sign in as ${row.label}`;
  if (row.error === SIGN_IN_EXPIRED) {
    const renew = row.active
      ? "use Codex to renew it"
      : `cx switch ${shellArgument(row.label)} and use Codex to renew it`;
    return `${row.label}: ${renew}. If Codex asks you to sign in, run ${signInAgain}.`;
  }
  if (row.error === SIGNED_OUT || row.error === NO_SAVED_LOGIN) {
    return `${row.label}: run ${signInAgain}.`;
  }
  return null;
}

function usageTitle() {
  return colorize("ACCOUNT USAGE", ANSI.cyan, colorEnabled());
}

export function renderUsage(rows, { now = Date.now() } = {}) {
  if (!rows.length) {
    return `${usageTitle()}\nNo accounts signed in with ChatGPT.`;
  }
  const nowSeconds = Math.floor(now / 1000);
  const showOther = rows.some((row) => row.other?.length);
  const tableRows = rows.map((row) => {
    const cells = [
      `${row.active ? "*" : " "} ${row.label}`,
      row.plan ?? "-",
      row.error ?? formatQuota(row.fiveHour, nowSeconds),
      row.error ? "-" : formatQuota(row.weekly, nowSeconds)
    ];
    return showOther ? [...cells, formatOtherQuotas(row.other, nowSeconds)] : cells;
  });
  const headers = ["ACCOUNT", "PLAN", "5H LEFT", "WEEKLY LEFT", ...(showOther ? ["OTHER LIMITS"] : [])];
  const hints = rows.map(signInHint).filter(Boolean);
  return [
    usageTitle(),
    buildTable(headers, tableRows, {
      cellColor: (index, cell) => (index === FIVE_HOUR_COLUMN || index === WEEKLY_COLUMN ? quotaColor(cell) : null)
    }),
    ...(hints.length ? ["", "To sign in again:", ...hints.map((hint) => `  ${hint}`)] : [])
  ].join("\n");
}

// The usage section never fails `cx status`: it is an addition to the local
// status, which must keep working when the registry can't be read.
export async function renderAccountUsage(codexHome, { fetchFn, now } = {}) {
  try {
    return renderUsage(await getAccountUsage(codexHome, { fetchFn, now }), { now });
  } catch (error) {
    return `${usageTitle()}\nUnavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}
