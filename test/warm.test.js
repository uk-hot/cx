import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { acquireLock } from "../src/locking.js";
import { accountKeyToFilename } from "../src/registry.js";
import { isCodexActive } from "../src/codex-activity.js";
import { runningWatcherPid } from "../src/warm-daemon.js";
import { loadDatabaseSync } from "../src/sqlite-state.js";
import {
  interpretExecOutput,
  nextWarmCheck,
  renderWarmChanges,
  renderWarmResults,
  runCodexExec,
  stopActiveExecs,
  warmAccounts,
  warmFailed
} from "../src/warm-service.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.js");
const NOW = Math.floor(Date.now() / 1000);

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function authFor(name, { accessToken = `access-${name}`, refreshToken = `refresh-${name}`, lastRefresh = "2026-11-01T00:00:00Z" } = {}) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      account_id: `account-${name}`,
      id_token: jwt({ sub: `user-${name}`, email: `${name}@example.com` }),
      access_token: accessToken,
      refresh_token: refreshToken
    },
    last_refresh: lastRefresh
  };
}

function accountFor(name) {
  return {
    account_key: `user-${name}::account-${name}`,
    email: `${name}@example.com`,
    alias: "",
    auth_mode: "chatgpt",
    provider: "openai"
  };
}

function windowBody({ weeklyIdle = false, weeklyUsed = weeklyIdle ? 0 : 40, resetAfter = weeklyIdle ? 604800 : 86400 } = {}) {
  return {
    plan_type: "team",
    rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: NOW + 18000 },
      secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604800, reset_after_seconds: resetAfter, reset_at: NOW + resetAfter }
    }
  };
}

async function makeHome(t, { accounts, live = null, snapshots = {} }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-warm-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir, { recursive: true });
  await fs.writeFile(path.join(accountsDir, "registry.json"), JSON.stringify({ schema_version: 3, active_account_key: null, accounts }));
  if (live) {
    await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify(live));
  }
  for (const [accountKey, auth] of Object.entries(snapshots)) {
    await fs.writeFile(path.join(accountsDir, accountKeyToFilename(accountKey)), JSON.stringify(auth));
  }
  return codexHome;
}

const snapshotOf = async (codexHome, accountKey) =>
  JSON.parse(await fs.readFile(path.join(codexHome, "accounts", accountKeyToFilename(accountKey)), "utf8"));

// Answers usage requests per access token; `afterWarm` is what an account
// reports once a request was sent as it.
function fakeUsage(byToken) {
  const warmed = new Set();
  return {
    warmed,
    fetchFn: async (_url, init) => {
      const token = init.headers.Authorization.replace("Bearer ", "");
      const entry = byToken[token];
      if (!entry) {
        return new Response("{}", { status: 401 });
      }
      const body = warmed.has(entry.name) && entry.afterWarm ? entry.afterWarm : entry.body;
      return new Response(JSON.stringify(body), { status: 200 });
    }
  };
}

test("an idle weekly window of a saved account is started in a private home, and refreshed tokens are saved", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const usage = fakeUsage({
    "access-one": { name: "one", body: windowBody({ weeklyIdle: true }), afterWarm: windowBody({ resetAfter: 604795 }) },
    "access-one-new": { name: "one", body: windowBody({ resetAfter: 604795 }) }
  });
  const calls = [];

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home, cwd }) => {
      calls.push({ home, cwd, auth: JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")) });
      // Codex refreshes the tokens in the home it runs in.
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", {
        accessToken: "access-one-new",
        refreshToken: "refresh-one-new",
        lastRefresh: "2026-11-19T00:00:00Z"
      })));
      usage.warmed.add("one");
      return { ok: true, detail: null };
    }
  });

  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].home, codexHome);
  assert.equal(calls[0].cwd, calls[0].home);
  assert.equal(calls[0].auth.tokens.refresh_token, "refresh-one");
  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "refresh-one-new");
  await assert.rejects(fs.access(calls[0].home), { code: "ENOENT" });
  assert.deepEqual(results.map(({ outcome, attempted }) => [outcome, attempted]), [["started", true]]);
  assert.equal(warmFailed(results), false);
  assert.match(renderWarmResults(results), /one@example\.com {2}weekly window started \(resets in 7d 0h\)/);
});

test("the logged-in account is warmed from a private copy too, and its refresh reaches auth.json", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, {
    accounts: [one],
    live: authFor("one", { refreshToken: "live", lastRefresh: "2026-11-05T00:00:00Z" }),
    snapshots: { [one.account_key]: authFor("one", { refreshToken: "older" }) }
  });
  const usage = fakeUsage({
    "access-one": { name: "one", body: windowBody({ weeklyIdle: true }) },
    "access-new": { name: "one", body: windowBody() }
  });
  const calls = [];

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home, cwd }) => {
      calls.push({ home, cwd, auth: JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")) });
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", {
        accessToken: "access-new",
        refreshToken: "new",
        lastRefresh: "2026-11-19T00:00:00Z"
      })));
      return { ok: true, detail: null };
    }
  });

  assert.notEqual(calls[0].home, codexHome);
  assert.equal(calls[0].auth.tokens.refresh_token, "live");
  const liveAfter = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
  assert.equal(liveAfter.tokens.refresh_token, "new");
  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "new");
  assert.equal(results[0].outcome, "started");
});

test("the cx lock is free while Codex runs, and a switch meanwhile still gets the refreshed tokens", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }), afterWarm: windowBody() } });

  await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home }) => {
      const release = await acquireLock(codexHome, "switch");
      // What `cx switch` to this account does meanwhile.
      await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify(authFor("one")));
      await release();
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "new", lastRefresh: "2026-11-19T00:00:00Z" })));
      usage.warmed.add("one");
      return { ok: true, detail: null };
    }
  });

  const liveAfter = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
  assert.equal(liveAfter.tokens.refresh_token, "new");
});

test("an account another cx warm is warming is left to it", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const inUse = path.join(codexHome, "tmp", `cx-warm-${Buffer.from(one.account_key).toString("base64url")}`);
  await fs.mkdir(inUse, { recursive: true });
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  await fs.writeFile(path.join(inUse, "cx-owner.json"), JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }));
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }) } });

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    runExec: async () => assert.fail("no request expected")
  });

  assert.deepEqual(results.map(({ outcome, attempted }) => [outcome, attempted]), [["failed", false]]);
  await fs.access(inUse);
});

function fiveHourIdleBody(weeklyUsed) {
  return {
    plan_type: "team",
    rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: NOW + 18000 },
      secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: NOW + 86400 }
    }
  };
}

function fiveHourRunningBody(weeklyUsed, resetAfter) {
  const body = fiveHourIdleBody(weeklyUsed);
  body.rate_limit.primary_window = { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: resetAfter, reset_at: NOW + resetAfter };
  return body;
}

test("while Codex is in use, idle 5-hour windows are started, except with under 10% of the week left", async (t) => {
  const plenty = accountFor("plenty");
  const low = accountFor("low");
  const codexHome = await makeHome(t, {
    accounts: [plenty, low],
    snapshots: { [plenty.account_key]: authFor("plenty"), [low.account_key]: authFor("low") }
  });
  const usage = fakeUsage({
    "access-plenty": { name: "plenty", body: fiveHourIdleBody(50), afterWarm: fiveHourRunningBody(50, 600) },
    "access-low": { name: "low", body: fiveHourIdleBody(91) }
  });
  const warmedHomes = [];
  const runExec = async ({ codexHome: home }) => {
    const auth = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
    warmedHomes.push(auth.tokens.account_id);
    usage.warmed.add("plenty");
    return { ok: true, detail: null };
  };

  const idle = await warmAccounts(codexHome, { fetchFn: usage.fetchFn, verifyDelayMs: 0, runExec, codexActive: false });
  assert.deepEqual(idle.map(({ outcome }) => outcome), ["running", "running"]);
  assert.deepEqual(warmedHomes, []);

  const results = await warmAccounts(codexHome, { fetchFn: usage.fetchFn, verifyDelayMs: 0, runExec, codexActive: true });
  assert.deepEqual(warmedHomes, ["account-plenty"]);
  assert.deepEqual(results.map(({ outcome, window }) => [outcome, window]), [["started", "5h"], ["running", undefined]]);
  assert.match(renderWarmResults(results), /plenty@example\.com {2}5-hour window started \(resets in 10m\)/);

  // While Codex stays in use, the next check is when that 5-hour window ends.
  assert.equal(nextWarmCheck(results, NOW * 1000, { codexActive: true }), (NOW + 600) * 1000 + 60 * 1000);
  assert.equal(nextWarmCheck(results, NOW * 1000, { codexActive: false }), NOW * 1000 + 30 * 60 * 1000);
});

test("a running window is left alone and the next check is right after it resets", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ resetAfter: 600 }) } });

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    runExec: async () => assert.fail("no request expected")
  });

  assert.equal(results[0].outcome, "running");
  assert.equal(nextWarmCheck(results, NOW * 1000), (NOW + 600) * 1000 + 60 * 1000);
  const first = renderWarmChanges(results, new Map());
  assert.match(first.text, /weekly window running/);
  assert.equal(renderWarmChanges(results, first.state).text, "");
});

test("an expired saved sign-in is renewed by the request, which also tells the quota", async (t) => {
  const one = accountFor("one");
  const expired = authFor("one", { accessToken: jwt({ exp: NOW - 60 }) });
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: expired } });
  const usage = fakeUsage({ fresh: { name: "one", body: windowBody({ resetAfter: 7200 }) } });

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home }) => {
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", { accessToken: "fresh", lastRefresh: "2026-11-19T00:00:00Z" })));
      return { ok: true, detail: null };
    }
  });

  assert.equal(results[0].outcome, "renewed");
  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.access_token, "fresh");
});

test("tokens older than the snapshot's are never saved over it", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, {
    accounts: [one],
    snapshots: { [one.account_key]: authFor("one", { lastRefresh: "2026-11-10T00:00:00Z" }) }
  });
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }) } });

  await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home }) => {
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "stale", lastRefresh: "2026-11-01T00:00:00Z" })));
      return { ok: true, detail: null };
    }
  });

  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "refresh-one");
});

test("a failed request is reported, fails the command, and still saves refreshed tokens", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }) } });

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    runExec: async ({ codexHome: home }) => {
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "rotated", lastRefresh: "2026-11-19T00:00:00Z" })));
      return { ok: false, detail: "Your workspace is out of credits." };
    }
  });

  assert.deepEqual(results.map(({ outcome, detail }) => [outcome, detail]), [["failed", "Your workspace is out of credits."]]);
  assert.equal(warmFailed(results), true);
  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "rotated");
});

test("a request that leaves the window idle is unconfirmed and checked again soon", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }) } });

  const results = await warmAccounts(codexHome, { fetchFn: usage.fetchFn, verifyDelayMs: 0, runExec: async () => ({ ok: true, detail: null }) });

  assert.equal(results[0].outcome, "unconfirmed");
  assert.equal(nextWarmCheck(results, NOW * 1000), NOW * 1000 + 5 * 60 * 1000);
});

test("skipped accounts are not sent a request", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }) } });

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    skip: () => true,
    runExec: async () => assert.fail("no request expected")
  });

  assert.equal(results[0].outcome, "waiting");
});

test("accounts that can't be read are reported without a request", async (t) => {
  const one = accountFor("one");
  const two = accountFor("two");
  const codexHome = await makeHome(t, {
    accounts: [one, two],
    snapshots: { [one.account_key]: authFor("one", { accessToken: jwt({ exp: NOW + 3600 }) }) }
  });

  const results = await warmAccounts(codexHome, {
    fetchFn: async () => new Response("{}", { status: 401 }),
    runExec: async () => assert.fail("no request expected")
  });

  assert.deepEqual(results.map(({ outcome, detail }) => [outcome, detail]), [["error", "signed out"], ["error", "no saved login"]]);
  assert.match(renderWarmResults(results), /signed out; cx switch to it and sign in to Codex again/);
  assert.equal(nextWarmCheck(results, NOW * 1000), NOW * 1000 + 30 * 60 * 1000);
});

test("tokens left in a warm-up home by a killed run are saved and the home removed", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const leftover = path.join(codexHome, "tmp", `cx-warm-${Buffer.from(one.account_key).toString("base64url")}`);
  await fs.mkdir(leftover, { recursive: true });
  await fs.writeFile(path.join(leftover, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "rescued", lastRefresh: "2026-11-19T00:00:00Z" })));
  // Owned by a process that is gone.
  const { pid: deadPid } = spawnSync(process.execPath, ["-e", ""]);
  await fs.writeFile(path.join(leftover, "cx-owner.json"), JSON.stringify({ pid: deadPid }));

  await warmAccounts(codexHome, { fetchFn: async () => new Response("{}", { status: 500 }) });

  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "rescued");
  await assert.rejects(fs.access(leftover), { code: "ENOENT" });
});

test("a warm-up home this process kept after a failed save is recovered on its next pass", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const kept = path.join(codexHome, "tmp", `cx-warm-${Buffer.from(one.account_key).toString("base64url")}`);
  await fs.mkdir(kept, { recursive: true });
  await fs.writeFile(path.join(kept, "cx-owner.json"), JSON.stringify({ pid: process.pid }));
  await fs.writeFile(path.join(kept, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "kept", lastRefresh: "2026-11-19T00:00:00Z" })));
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }), afterWarm: windowBody() } });

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home }) => {
      // Codex starts from the saved tokens, not the used-up ones.
      assert.equal(JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8")).tokens.refresh_token, "kept");
      usage.warmed.add("one");
      return { ok: true, detail: null };
    }
  });

  assert.equal(results[0].outcome, "started");
  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "kept");
});

test("renewing an expired sign-in succeeds on a plan without a weekly window", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, {
    accounts: [one],
    snapshots: { [one.account_key]: authFor("one", { accessToken: jwt({ exp: NOW - 60 }) }) }
  });
  const fiveHourOnly = {
    plan_type: "free",
    rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 9000, reset_at: NOW + 9000 } }
  };
  const usage = fakeUsage({ fresh: { name: "one", body: fiveHourOnly } });

  const results = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home }) => {
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", { accessToken: "fresh", lastRefresh: "2026-11-19T00:00:00Z" })));
      return { ok: true, detail: null };
    }
  });

  assert.equal(results[0].outcome, "renewed");
  assert.equal(warmFailed(results), false);
});

test("the watch log repeats an unchanged problem only once", () => {
  const signedOut = [{ accountKey: "k", label: "one@example.com", outcome: "error", attempted: false, detail: "signed out" }];
  const first = renderWarmChanges(signedOut, new Map());
  assert.match(first.text, /signed out/);
  assert.equal(renderWarmChanges(signedOut, first.state).text, "");
  const none = renderWarmChanges([], first.state);
  assert.match(none.text, /No accounts/);
  assert.equal(renderWarmChanges([], none.state).text, "");
});

test("a watcher pid file from before the machine started doesn't count", async (t) => {
  const codexHome = await makeHome(t, { accounts: [] });
  await fs.mkdir(path.join(codexHome, "tmp"), { recursive: true });
  const pidFile = path.join(codexHome, "tmp", "cx-warm.pid");
  await fs.writeFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00Z" }));
  assert.equal(await runningWatcherPid(codexHome), null);
  // This test process runs with "warm" in its command line.
  await fs.writeFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.equal(await runningWatcherPid(codexHome), process.pid);
});

test("codex exec output: a completed turn succeeds, otherwise the error says why", () => {
  assert.deepEqual(interpretExecOutput(0, '{"type":"thread.started"}\n{"type":"turn.completed","usage":{}}\n', ""), { ok: true, detail: null });
  assert.deepEqual(
    interpretExecOutput(1, '{"type":"error","message":"a"}\n{"type":"turn.failed","error":{"message":"out of credits"}}\n', "warning"),
    { ok: false, detail: "out of credits" }
  );
  assert.deepEqual(interpretExecOutput(2, "", "error: unexpected argument\n\nUsage: codex\n"), { ok: false, detail: "Usage: codex" });
  assert.deepEqual(interpretExecOutput(0, '{"type":"turn.started"}', ""), { ok: false, detail: "codex exited with code 0" });
});

test("--watch belongs to cx warm only", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-warm-cli-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "list", "--watch"], { env: { ...process.env, HOME: home, USERPROFILE: home } }),
    (error) => /Unknown option '--watch' for cx list/.test(error.stderr)
  );
});

test("cx warm with no accounts sends nothing", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-warm-cli-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "warm"], { env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(stdout.trim(), "No accounts signed in with ChatGPT.");
});

async function cli(home, ...args) {
  return execFileAsync(process.execPath, [cliPath, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home } });
}

const pidOf = async (home) => JSON.parse(await fs.readFile(path.join(home, ".codex", "tmp", "cx-warm.pid"), "utf8")).pid;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, timeoutMs = 5000) {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("condition not met in time");
}

test("cx warm start runs in the background, any cx command revives it, and stop turns it off", { timeout: 30000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-warm-bg-"));
  t.after(async () => {
    await cli(home, "warm", "stop").catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  });

  const started = await cli(home, "warm", "start");
  assert.match(started.stdout, /cx warm runs in the background \(pid \d+\)/);
  const first = await pidOf(home);
  assert.ok(isAlive(first));
  assert.match((await cli(home, "warm", "start")).stdout, new RegExp(`already runs in the background \\(pid ${first}\\)`));
  await assert.rejects(cli(home, "warm", "--watch"), (error) => /cx warm already runs/.test(error.stderr));
  assert.match((await cli(home, "status")).stdout, new RegExp(`Background warm: running \\(pid ${first}\\)`));

  // A reboot or crash: the next cx command starts it again.
  process.kill(first, "SIGKILL");
  await waitFor(() => !isAlive(first));
  await cli(home, "list");
  const second = await pidOf(home);
  assert.notEqual(second, first);
  assert.ok(isAlive(second));

  assert.match((await cli(home, "warm", "stop")).stdout, new RegExp(`Stopped cx warm \\(pid ${second}\\)`));
  assert.ok(!isAlive(second));
  await cli(home, "list");
  await assert.rejects(fs.access(path.join(home, ".codex", "tmp", "cx-warm.pid")));
  assert.match((await cli(home, "status")).stdout, /Background warm: off/);
  assert.match(await fs.readFile(path.join(home, ".codex", "log", "cx-warm.log"), "utf8"), /No accounts signed in with ChatGPT/);
});

test("Codex counts as in use while a session was written in the last 10 minutes, a resumed old one too", async (t) => {
  const codexHome = await makeHome(t, { accounts: [] });
  const now = Date.now();
  async function rollout(day, name, ageMs) {
    const dir = path.join(codexHome, "sessions", ...day.split("/"));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-${name}.jsonl`);
    await fs.writeFile(file, "{}\n");
    const time = new Date(now - ageMs);
    await fs.utimes(file, time, time);
    return file;
  }

  assert.equal(await isCodexActive(codexHome, now), false);
  await rollout("2026/11/19", "today", 20 * 60 * 1000);
  await rollout("2026/11/18", "yesterday", 60 * 60 * 1000);
  assert.equal(await isCodexActive(codexHome, now), false);

  await rollout("2026/11/19", "working", 30 * 1000);
  assert.equal(await isCodexActive(codexHome, now), true);
  await fs.rm(path.join(codexHome, "sessions", "2026", "11", "19", "rollout-working.jsonl"));

  // A session from weeks ago, resumed now, keeps writing to its old file.
  const resumed = await rollout("2026/10/01", "resumed", 30 * 1000);
  assert.equal(await isCodexActive(codexHome, now), false);
  const Database = loadDatabaseSync();
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("t1", resumed, Math.floor(now / 1000));
  db.close();
  assert.equal(await isCodexActive(codexHome, now), true);
});

test("an expired sign-in of the account Codex is logged in to is left to Codex", async (t) => {
  const one = accountFor("one");
  const expired = authFor("one", { accessToken: jwt({ exp: NOW - 60 }) });
  const codexHome = await makeHome(t, { accounts: [one], live: expired, snapshots: { [one.account_key]: expired } });

  const results = await warmAccounts(codexHome, {
    fetchFn: async () => new Response("{}", { status: 401 }),
    runExec: async () => assert.fail("no request expected")
  });

  assert.deepEqual(results.map(({ outcome, attempted }) => [outcome, attempted]), [["renews-on-use", false]]);
  assert.equal(warmFailed(results), false);
  assert.match(renderWarmResults(results), /Codex is logged in to it and renews it when you use it/);
  assert.equal(nextWarmCheck(results, NOW * 1000), NOW * 1000 + 30 * 60 * 1000);
});

test("tokens Codex refreshes are saved while it still runs", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, {
    accounts: [one],
    live: authFor("one", { refreshToken: "live" }),
    snapshots: { [one.account_key]: authFor("one") }
  });
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }), afterWarm: windowBody() } });
  let savedWhileRunning = false;

  await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home }) => {
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "new", lastRefresh: "2026-11-19T00:00:00Z" })));
      for (let waited = 0; waited < 5000 && !savedWhileRunning; waited += 100) {
        const live = JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
        savedWhileRunning = live.tokens.refresh_token === "new"
          && (await snapshotOf(codexHome, one.account_key)).tokens.refresh_token === "new";
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      usage.warmed.add("one");
      return { ok: true, detail: null };
    }
  });

  assert.ok(savedWhileRunning);
});

test("a warm-up home whose owner pid was recorded before the machine started is recovered", async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const leftover = path.join(codexHome, "tmp", `cx-warm-${Buffer.from(one.account_key).toString("base64url")}`);
  await fs.mkdir(leftover, { recursive: true });
  await fs.writeFile(path.join(leftover, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "rescued", lastRefresh: "2026-11-19T00:00:00Z" })));
  // The pid now belongs to an unrelated process.
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill());
  await fs.writeFile(path.join(leftover, "cx-owner.json"), JSON.stringify({ pid: unrelated.pid, startedAt: "2000-01-01T00:00:00Z" }));

  await warmAccounts(codexHome, { fetchFn: async () => new Response("{}", { status: 500 }) });

  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "rescued");
  await assert.rejects(fs.access(leftover), { code: "ENOENT" });
});

const posixOnly = { skip: process.platform === "win32" && "process groups are POSIX" };

function spawnGroup() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });
  child.unref();
  return child;
}

test("a Codex that outlives its cx keeps its warm-up home until it ends", posixOnly, async (t) => {
  const one = accountFor("one");
  const codexHome = await makeHome(t, { accounts: [one], snapshots: { [one.account_key]: authFor("one") } });
  const warmDir = path.join(codexHome, "tmp", `cx-warm-${Buffer.from(one.account_key).toString("base64url")}`);
  const usage = fakeUsage({ "access-one": { name: "one", body: windowBody({ weeklyIdle: true }) } });
  const survivor = spawnGroup();
  t.after(() => survivor.kill("SIGKILL"));

  // A Codex that is still running when its request returns.
  const first = await warmAccounts(codexHome, {
    fetchFn: usage.fetchFn,
    verifyDelayMs: 0,
    runExec: async ({ codexHome: home, onSpawn }) => {
      onSpawn(survivor.pid);
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(authFor("one", { refreshToken: "late", lastRefresh: "2026-11-19T00:00:00Z" })));
      return { ok: false, detail: "codex timed out" };
    }
  });
  assert.equal(first[0].outcome, "failed");
  await fs.access(warmDir);
  assert.equal(JSON.parse(await fs.readFile(path.join(warmDir, "cx-owner.json"), "utf8")).execPid, survivor.pid);

  // Even with its cx gone, the home is in use while that Codex runs.
  const { pid: deadPid } = spawnSync(process.execPath, ["-e", ""]);
  const owner = JSON.parse(await fs.readFile(path.join(warmDir, "cx-owner.json"), "utf8"));
  await fs.writeFile(path.join(warmDir, "cx-owner.json"), JSON.stringify({ ...owner, pid: deadPid }));
  const busy = await warmAccounts(codexHome, { fetchFn: usage.fetchFn, runExec: async () => assert.fail("no request expected") });
  assert.deepEqual(busy.map(({ outcome, attempted }) => [outcome, attempted]), [["failed", false]]);
  await fs.access(warmDir);

  survivor.kill("SIGKILL");
  await waitFor(() => !isAlive(survivor.pid));
  await warmAccounts(codexHome, { fetchFn: async () => new Response("{}", { status: 500 }) });
  await assert.rejects(fs.access(warmDir), { code: "ENOENT" });
  assert.equal((await snapshotOf(codexHome, one.account_key)).tokens.refresh_token, "late");
});

async function fakeCodex(t, script) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cx-fake-codex-"));
  const saved = { PATH: process.env.PATH, CX_TEST_DIR: process.env.CX_TEST_DIR };
  t.after(async () => {
    process.env.PATH = saved.PATH;
    if (saved.CX_TEST_DIR === undefined) {
      delete process.env.CX_TEST_DIR;
    } else {
      process.env.CX_TEST_DIR = saved.CX_TEST_DIR;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, "codex"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  process.env.CX_TEST_DIR = dir;
  return dir;
}

const readPid = async (file) => {
  for (let waited = 0; waited < 5000; waited += 50) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (text.trim()) {
      return Number(text.trim());
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return assert.fail(`no pid in ${file}`);
};

test("codex exec runs at low effort, and what it leaves running is ended with it", posixOnly, async (t) => {
  const dir = await fakeCodex(t, [
    'echo "$@" > "$CX_TEST_DIR/args"',
    'sleep 60 >/dev/null 2>&1 &',
    'echo $! > "$CX_TEST_DIR/child"',
    "echo '{\"type\":\"turn.completed\"}'"
  ].join("\n"));

  const result = await runCodexExec({ codexHome: dir, cwd: dir });

  assert.deepEqual(result, { ok: true, detail: null });
  assert.match(await fs.readFile(path.join(dir, "args"), "utf8"), /-c model_reasoning_effort=low/);
  const straggler = await readPid(path.join(dir, "child"));
  await waitFor(() => !isAlive(straggler));
});

test("a codex exec that times out or is stopped is ended with everything it started", posixOnly, async (t) => {
  const dir = await fakeCodex(t, 'sleep 60 &\necho $! > "$CX_TEST_DIR/child"\nwait');

  const timedOut = await runCodexExec({ codexHome: dir, cwd: dir, timeoutMs: 300 });
  assert.deepEqual(timedOut, { ok: false, detail: "codex timed out" });
  const first = await readPid(path.join(dir, "child"));
  await waitFor(() => !isAlive(first));

  await fs.rm(path.join(dir, "child"));
  let spawned;
  const running = runCodexExec({ codexHome: dir, cwd: dir, onSpawn: (pid) => { spawned = pid; } });
  const second = await readPid(path.join(dir, "child"));
  assert.ok(Number.isInteger(spawned));
  stopActiveExecs();
  assert.equal((await running).ok, false);
  await waitFor(() => !isAlive(second) && !isAlive(spawned));
});

test("after the background cx warm failed to start, cx commands wait a while before trying again", { timeout: 30000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-warm-revive-"));
  t.after(async () => {
    await cli(home, "warm", "stop").catch(() => {});
    await fs.rm(home, { recursive: true, force: true });
  });
  const codexHome = path.join(home, ".codex");
  await fs.mkdir(path.join(codexHome, "accounts"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "tmp"), { recursive: true });
  await fs.writeFile(path.join(codexHome, "accounts", "cx-warm.json"), JSON.stringify({ background: true }));
  const failedFile = path.join(codexHome, "tmp", "cx-warm.start-failed");
  await fs.writeFile(failedFile, JSON.stringify({ at: new Date().toISOString(), error: "exited at once" }));

  await cli(home, "list");
  await assert.rejects(fs.access(path.join(codexHome, "tmp", "cx-warm.pid")));
  assert.match((await cli(home, "status")).stdout, /Background warm: on but not running; it failed to start at .* \(exited at once\)/);

  // Long enough ago: the next command tries again, and success clears it.
  await fs.writeFile(failedFile, JSON.stringify({ at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), error: "exited at once" }));
  await cli(home, "list");
  assert.ok(isAlive(await pidOf(home)));
  await assert.rejects(fs.access(failedFile));
});
