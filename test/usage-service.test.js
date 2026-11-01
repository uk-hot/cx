import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-usage-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir, { recursive: true });
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

function cliEnv(codexHome, extra = {}) {
  const home = path.dirname(codexHome);
  return { ...process.env, HOME: home, USERPROFILE: home, ...extra };
}

function runStatus(codexHome) {
  return execFileAsync(process.execPath, [cliPath, "status"], { env: cliEnv(codexHome) });
}

async function usageOf(t, name, respond, options = {}) {
  const account = accountFor(name, options.account);
  const codexHome = await makeHome(t, {
    accounts: [account],
    snapshots: { [account.account_key]: authFor(name) }
  });
  const [row] = await getAccountUsage(codexHome, { fetchFn: async () => respondWith(respond) });
  return row;
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
  assert.deepEqual(rows[0].fiveHour, { remainingPercent: 75, resetsAt: 1000 + 3 * 3600, windowSeconds: 18000 });
  assert.deepEqual(rows[0].weekly, { remainingPercent: 40, resetsAt: 1000 + 2 * 86400, windowSeconds: 604800 });
  assert.deepEqual(rows[0].other, []);
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
  assert.match(renderUsage(rows), /No accounts signed in with ChatGPT\./);
});

test("windows are told apart by length, not position", async (t) => {
  const row = await usageOf(t, "one", {
    plan_type: "free",
    rate_limit: {
      primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_at: 5000 },
      secondary_window: null
    }
  });

  assert.equal(row.fiveHour, null);
  assert.deepEqual(row.weekly, { remainingPercent: 70, resetsAt: 5000, windowSeconds: 604800 });
});

test("a window that is neither 5h nor weekly is kept apart", async (t) => {
  const hourAndMonth = await usageOf(t, "one", {
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 3600, reset_at: 2000 },
      secondary_window: { used_percent: 60, limit_window_seconds: 2592000, reset_at: 3000 }
    }
  });
  assert.equal(hourAndMonth.fiveHour, null);
  assert.equal(hourAndMonth.weekly, null);
  assert.deepEqual(hourAndMonth.other.map((quota) => quota.windowSeconds), [3600, 2592000]);

  const noLength = await usageOf(t, "two", {
    rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: null, reset_at: 2000 } }
  });
  assert.equal(noLength.fiveHour, null);
  assert.deepEqual(noLength.other, [{ remainingPercent: 60, resetsAt: 2000, windowSeconds: null }]);
});

test("a second window of the same length is not dropped", async (t) => {
  const row = await usageOf(t, "one", {
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 2000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 3000 }
    }
  });
  assert.equal(row.weekly.remainingPercent, 90);
  assert.deepEqual(row.other.map((quota) => quota.remainingPercent), [80]);
});

test("a plan without limits keeps its plan and is not an error", async (t) => {
  for (const [name, rateLimit] of [
    ["none", null],
    ["empty", { primary_window: null, secondary_window: null }]
  ]) {
    const row = await usageOf(t, name, { plan_type: "enterprise", rate_limit: rateLimit });
    assert.deepEqual(
      [row.error, row.plan, row.fiveHour, row.weekly],
      [undefined, "enterprise", null, null]
    );
    assert.match(renderUsage([{ ...row, label: "a@example.com" }]), /a@example\.com\s+\| enterprise \| -\s+\| -/);
  }
});

test("one failing account does not affect the others", async (t) => {
  const failures = {
    expired: [() => respondWith({}, 401), "sign-in expired"],
    blocked: [() => respondWith({}, 503), "HTTP 503"],
    malformed: [() => new Response("<html>"), "unexpected response"],
    empty: [() => respondWith({ rate_limit: {} }), "unexpected response"],
    missing: [() => respondWith({ plan_type: "team" }), "unexpected response"],
    renamed: [() => respondWith({ rate_limit: { five_hour: {} } }), "unexpected response"],
    badType: [() => respondWith({ rate_limit: "none" }), "unexpected response"],
    badWindow: [() => respondWith({ rate_limit: { primary_window: { used_percent: "x" } } }), "unexpected response"],
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

test("a malformed login fails only its own account", async (t) => {
  const brokenAuth = {
    auth_mode: "chatgpt",
    tokens: { account_id: "account-broken", id_token: { raw: "x" }, access_token: "access-broken" }
  };
  const broken = accountFor("broken");
  const badToken = accountFor("token");
  const good = accountFor("good");

  // Malformed both as a snapshot and as the live login every account is compared to.
  for (const live of [null, brokenAuth]) {
    const codexHome = await makeHome(t, {
      accounts: [broken, badToken, good],
      live,
      snapshots: {
        [broken.account_key]: brokenAuth,
        [badToken.account_key]: authFor("token", { raw: "x" }),
        [good.account_key]: authFor("good")
      }
    });

    const rows = await getAccountUsage(codexHome, { fetchFn: async () => respondWith(usageBody()) });

    assert.deepEqual(rows.map((row) => row.error), ["no saved login", "no saved login", undefined]);
    assert.equal(rows[2].weekly.remainingPercent, 40);
  }
});

test("only the account Codex is logged in to is marked active", async (t) => {
  const one = accountFor("one");
  const proxy = accountFor("proxy", { provider: "my-proxy" });
  const snapshots = { [one.account_key]: authFor("one") };
  const fetchFn = async () => respondWith(usageBody());
  const activeFor = async (active, live) => {
    const codexHome = await makeHome(t, { accounts: [one, proxy], active, live, snapshots });
    const [row] = await getAccountUsage(codexHome, { fetchFn });
    return row.active;
  };

  assert.equal(await activeFor(one.account_key, authFor("one")), true);
  assert.equal(await activeFor(one.account_key, authFor("unregistered")), false);
  assert.equal(await activeFor(one.account_key, { auth_mode: "apikey", OPENAI_API_KEY: "key" }), false);
  assert.equal(await activeFor(one.account_key, null), false);
  // A third-party provider leaves the previous ChatGPT tokens in auth.json.
  assert.equal(await activeFor(proxy.account_key, authFor("one")), false);
});

test("accounts without an email or alias still get a name", async (t) => {
  const row = await usageOf(t, "one", usageBody(), { account: { email: null, alias: "" } });
  assert.equal(row.label, "user-one::account-one");
  const aliased = await usageOf(t, "two", usageBody(), { account: { email: null, alias: "work" } });
  assert.equal(aliased.label, "work");
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
  assert.doesNotMatch(output, /OTHER LIMITS/);
});

test("limits outside the two columns get their own, labelled by length", () => {
  const output = renderUsage([
    {
      label: "one@example.com",
      other: [
        { remainingPercent: 40, resetsAt: 1000 + 90, windowSeconds: 2592000 },
        { remainingPercent: 60, resetsAt: null, windowSeconds: 3600 },
        { remainingPercent: 5, resetsAt: null, windowSeconds: null }
      ]
    },
    { label: "two@example.com", other: [] }
  ], { now: 1000 * 1000 });

  assert.match(output, /OTHER LIMITS/);
  assert.match(output, /30d: 40% \(resets in 2m\), 1h: 60%, unknown window: 5%/);
  assert.match(output, /two@example\.com\s+\| -\s+\| -\s+\| -\s+\| -/);
});

test("cx status works with no accounts and sends nothing", async (t) => {
  const codexHome = await makeHome(t, { accounts: [] });

  const { stdout } = await runStatus(codexHome);

  assert.match(stdout, /ACCOUNT USAGE\nNo accounts signed in with ChatGPT\./);
  assert.ok(stdout.indexOf("ROLLOUT FILES") < stdout.indexOf("ACCOUNT USAGE"));
});

test("an unreadable registry leaves the local status working", async (t) => {
  const codexHome = await makeHome(t, { accounts: [] });
  await fs.writeFile(path.join(codexHome, "accounts", "registry.json"), "{broken");

  const { stdout } = await runStatus(codexHome);

  assert.match(stdout, /ROLLOUT FILES/);
  assert.match(stdout, /ACCOUNT USAGE\nUnavailable: /);
});

test("a local status failure still shows the usage and fails the command", async (t) => {
  const codexHome = await makeHome(t, { accounts: [] });
  await fs.writeFile(path.join(codexHome, "state_5.sqlite"), "this is not a database, just text padding it out");

  await assert.rejects(runStatus(codexHome), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /ACCOUNT USAGE\nNo accounts signed in with ChatGPT\./);
    assert.match(error.stderr, /database/i);
    return true;
  });
});

test("an unresponsive proxy delays only the usage, which times out and lets cx exit", { timeout: 30000 }, async (t) => {
  const account = accountFor("one");
  const codexHome = await makeHome(t, {
    accounts: [account],
    active: account.account_key,
    live: authFor("one")
  });
  const proxy = http.createServer();
  const connected = once(proxy, "connect");
  proxy.on("connect", (request, socket) => {
    socket.on("error", () => {});
    t.after(() => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => proxy.close());
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  const child = spawn(process.execPath, [cliPath, "status"], {
    env: cliEnv(codexHome, {
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: ""
    }),
    stdio: ["ignore", "pipe", "inherit"]
  });
  t.after(() => child.kill());
  let stdout = "";
  const localStatusShown = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("SQLITE STATE")) {
        resolve();
      }
    });
  });

  const [[request]] = await Promise.all([connected, localStatusShown]);
  assert.equal(request.url, "chatgpt.com:443");
  assert.doesNotMatch(stdout, /ACCOUNT USAGE/);

  const [code] = await once(child, "close");
  assert.equal(code, 0);
  assert.match(stdout, /ACCOUNT USAGE[\s\S]*\* one@example\.com\s+\| -\s+\| timed out/);
});
