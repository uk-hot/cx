import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { accountKeyToFilename } from "../src/auth-service.js";
import { getAccountUsage, renderUsage } from "../src/usage-service.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.js");

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function authFor(name, accessToken = `access-${name}`) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      account_id: `account-${name}`,
      id_token: jwt({ sub: `user-${name}`, email: `${name}@example.com` }),
      access_token: accessToken,
      refresh_token: `refresh-${name}`
    }
  };
}

function accountFor(name, overrides = {}) {
  return {
    account_key: `user-${name}::account-${name}`,
    email: `${name}@example.com`,
    alias: "",
    auth_mode: "chatgpt",
    provider: "openai",
    ...overrides
  };
}

function usageBody({ fiveHourUsed = 25, weeklyUsed = 60, plan = "team" } = {}) {
  return {
    plan_type: plan,
    rate_limit: {
      primary_window: { used_percent: fiveHourUsed, limit_window_seconds: 18000, reset_at: 1000 + 3 * 3600 },
      secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604800, reset_at: 1000 + 2 * 86400 }
    }
  };
}

function respondWith(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// A home with `live` logged in, and a snapshot for every entry of `snapshots`.
async function makeHome(t, { accounts, active = null, live = null, snapshots = {} }) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-usage-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir);
  await fs.writeFile(
    path.join(accountsDir, "registry.json"),
    JSON.stringify({ schema_version: 3, active_account_key: active, accounts })
  );
  if (live) {
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify(live));
  }
  for (const [accountKey, auth] of Object.entries(snapshots)) {
    await fs.writeFile(path.join(accountsDir, accountKeyToFilename(accountKey)), JSON.stringify(auth));
  }
  return codexHome;
}

test("every account is queried with its own token, the logged-in one from auth.json", async (t) => {
  const one = accountFor("one");
  const two = accountFor("two");
  const codexHome = await makeHome(t, {
    accounts: [one, two],
    active: one.account_key,
    live: authFor("one", "fresh-token"),
    snapshots: { [one.account_key]: authFor("one", "stale-token"), [two.account_key]: authFor("two") }
  });
  const requests = [];

  const rows = await getAccountUsage(codexHome, {
    fetchFn: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return respondWith(usageBody());
    }
  });

  assert.deepEqual(
    requests.map(({ headers }) => [headers.Authorization, headers["ChatGPT-Account-Id"]]).sort(),
    [["Bearer access-two", "account-two"], ["Bearer fresh-token", "account-one"]]
  );
  assert.ok(requests.every(({ url }) => url === "https://chatgpt.com/backend-api/wham/usage"));
  assert.deepEqual(rows.map(({ label, active }) => [label, active]), [
    ["one@example.com", true],
    ["two@example.com", false]
  ]);
  assert.equal(rows[0].plan, "team");
  assert.deepEqual(rows[0].fiveHour, { remainingPercent: 75, resetsAt: 1000 + 3 * 3600 });
  assert.deepEqual(rows[0].weekly, { remainingPercent: 40, resetsAt: 1000 + 2 * 86400 });
});

test("reading usage leaves every account file untouched", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, {
    accounts: [one],
    active: one.account_key,
    live: authFor("one"),
    snapshots: { [one.account_key]: authFor("one") }
  });
  const read = async () => {
    const names = await fs.readdir(path.join(codexHome, "accounts"));
    const files = names.map((name) => path.join(codexHome, "accounts", name));
    return Promise.all([...files, path.join(codexHome, "auth.json")].map((file) => fs.readFile(file, "utf8")));
  };
  const before = await read();

  await getAccountUsage(codexHome, { fetchFn: async () => respondWith(usageBody()) });

  assert.deepEqual(await read(), before);
});

test("API keys and third-party providers are left out", async (t) => {
  const official = accountFor("one");
  const codexHome = await makeHome(t, {
    accounts: [
      official,
      accountFor("key", { auth_mode: "apikey" }),
      accountFor("proxy", { provider: "my-proxy" })
    ],
    snapshots: { [official.account_key]: authFor("one") }
  });
  let calls = 0;

  const rows = await getAccountUsage(codexHome, {
    fetchFn: async () => {
      calls += 1;
      return respondWith(usageBody());
    }
  });

  assert.equal(calls, 1);
  assert.deepEqual(rows.map((row) => row.label), ["one@example.com"]);
});

test("no accounts means no request", async (t) => {
  const codexHome = await makeHome(t, { accounts: [accountFor("key", { auth_mode: "apikey" })] });
  const rows = await getAccountUsage(codexHome, {
    fetchFn: async () => assert.fail("nothing to query")
  });
  assert.deepEqual(rows, []);
  assert.match(renderUsage(rows), /No OpenAI accounts registered\./);
});

test("windows are told apart by length, not position", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });

  const [row] = await getAccountUsage(codexHome, {
    fetchFn: async () => respondWith({
      plan_type: "free",
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 5000 },
        secondary_window: null
      }
    })
  });

  assert.equal(row.fiveHour, null);
  assert.deepEqual(row.weekly, { remainingPercent: 70, resetsAt: 5000 });
});

test("one failing account does not affect the others", async (t) => {
  const failures = {
    expired: [() => respondWith({}, 401), "sign-in expired"],
    blocked: [() => respondWith({}, 503), "HTTP 503"],
    malformed: [() => new Response("<html>"), "unexpected response"],
    empty: [() => respondWith({ rate_limit: {} }), "unexpected response"],
    offline: [() => { throw new TypeError("fetch failed"); }, "unreachable"],
    slow: [() => { throw new DOMException("timed out", "TimeoutError"); }, "timed out"]
  };
  const names = Object.keys(failures);
  const accounts = [...names, "good"].map((name) => accountFor(name));
  const snapshots = Object.fromEntries(accounts.map((account, index) => [
    account.account_key,
    authFor([...names, "good"][index])
  ]));
  const codexHome = await makeHome(t, { accounts, snapshots });

  const rows = await getAccountUsage(codexHome, {
    fetchFn: async (url, init) => {
      const name = init.headers["ChatGPT-Account-Id"].replace("account-", "");
      return name === "good" ? respondWith(usageBody()) : failures[name][0]();
    }
  });

  assert.deepEqual(rows.slice(0, -1).map((row) => row.error), names.map((name) => failures[name][1]));
  assert.equal(rows.at(-1).error, undefined);
  assert.equal(rows.at(-1).weekly.remainingPercent, 40);
});

test("an account with no usable saved login is reported without a request", async (t) => {
  const missing = accountFor("missing");
  const wrong = accountFor("wrong");
  const codexHome = await makeHome(t, {
    accounts: [missing, wrong],
    snapshots: { [wrong.account_key]: authFor("someone-else") }
  });

  const rows = await getAccountUsage(codexHome, {
    fetchFn: async () => assert.fail("no token to send")
  });

  assert.deepEqual(rows.map((row) => row.error), ["no saved login", "no saved login"]);
});

test("the table shows what is left and when it resets", () => {
  const output = renderUsage([
    {
      label: "one@example.com",
      active: true,
      plan: "team",
      fiveHour: { remainingPercent: 33, resetsAt: 1000 + 3 * 3600 + 40 * 60 },
      weekly: { remainingPercent: 90, resetsAt: 1000 + 6 * 86400 + 22 * 3600 }
    },
    { label: "two@example.com", active: false, plan: "plus", fiveHour: null, weekly: { remainingPercent: 0, resetsAt: 1000 + 59 } },
    { label: "three@example.com", active: false, error: "sign-in expired" }
  ], { now: 1000 * 1000 });

  assert.match(output, /ACCOUNT USAGE/);
  assert.match(output, /\| \* one@example\.com\s+\| team\s+\| 33% \(resets in 3h 40m\) \| 90% \(resets in 6d 22h\)/);
  assert.match(output, /\|   two@example\.com\s+\| plus\s+\| -\s+\| 0% \(resets in 1m\)/);
  assert.match(output, /\|   three@example\.com\s+\| -\s+\| sign-in expired\s+\| -/);
});

test("cx status works with no accounts and sends nothing", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-status-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".codex"));

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "status"], {
    env: { ...process.env, HOME: home, USERPROFILE: home }
  });

  assert.match(stdout, /ACCOUNT USAGE\nNo OpenAI accounts registered\./);
  assert.ok(stdout.indexOf("ACCOUNT USAGE") < stdout.indexOf("ROLLOUT FILES"));
});
