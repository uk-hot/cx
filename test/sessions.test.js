import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { addAccount, addAccountWithLogin } from "../src/accounts.js";
import { runSwitch } from "../src/service.js";
import { assignSessions, deleteSessions, finishSessionCleanup, loadSessions, selectSessions } from "../src/session-manager.js";
import { lastActivityMs, readThreadOwners } from "../src/session-owners.js";
import { loadDatabaseSync, readThreadRows } from "../src/sqlite-state.js";

const Database = loadDatabaseSync();
const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.js");

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

// Codex tags threads with the ChatGPT user id from the auth claim, which is
// not the sign-in `sub` cx keys accounts on.
function oauthAuth(name, accountId = `account-${name}`) {
  const auth = { chatgpt_account_id: accountId, chatgpt_user_id: `user-chatgpt-${name}` };
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      id_token: jwt({ sub: `auth0|${name}`, email: `${name}@example.com`, "https://api.openai.com/auth": auth }),
      access_token: jwt({ sub: `auth0|${name}`, "https://api.openai.com/auth": auth }),
      refresh_token: `refresh-${name}`
    }
  });
}

const iso = (ms) => new Date(ms).toISOString();
const meta = (id) => JSON.stringify({ timestamp: iso(0), type: "session_meta", payload: { id, model_provider: "openai" } });
const turn = (ms) => JSON.stringify({ timestamp: iso(ms), type: "event_msg", payload: { type: "task_started" } });
const reply = (ms, text = "ok") => JSON.stringify({ timestamp: iso(ms), type: "response_item", payload: { type: "message", role: "assistant", content: text } });

async function makeHome(t) {
  const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), "cx-sessions-"));
  t.after(() => fsp.rm(codexHome, { recursive: true, force: true }));
  await fsp.mkdir(path.join(codexHome, "sessions"), { recursive: true });
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER, updated_at_ms INTEGER, archived INTEGER NOT NULL DEFAULT 0,
    creator_user_id TEXT, creator_account_id TEXT)`);
  db.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)");
  db.close();
  return codexHome;
}

/**
 * Writes a thread as Codex would: a rollout with a turn at each of `turns`,
 * and its row, optionally tagged with its creator.
 */
async function putThread(codexHome, id, { turns = [], creator = null, title = id } = {}) {
  const rolloutPath = path.join(codexHome, "sessions", `rollout-${id}.jsonl`);
  const lines = [meta(id), ...turns.flatMap((ms) => [turn(ms), reply(ms + 1)])];
  await fsp.writeFile(rolloutPath, `${lines.join("\n")}\n`);
  const createdAt = turns[0] ?? Date.now();
  const updatedAt = turns.at(-1) ?? createdAt;
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.prepare(`INSERT INTO threads (id, rollout_path, model_provider, title, created_at_ms, updated_at_ms, creator_user_id, creator_account_id)
    VALUES (?, ?, 'openai', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`)
    .run(id, rolloutPath, title, createdAt, updatedAt, creator ? `user-chatgpt-${creator}` : null, creator ? `account-${creator}` : null);
  db.close();
  return rolloutPath;
}

/** Appends a turn to an existing thread, as resuming it does. */
async function resume(codexHome, id, ms) {
  const rolloutPath = path.join(codexHome, "sessions", `rollout-${id}.jsonl`);
  await fsp.appendFile(rolloutPath, `${turn(ms)}\n${reply(ms + 1)}\n`);
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.prepare("UPDATE threads SET updated_at_ms = ? WHERE id = ?").run(ms, id);
  db.close();
}

async function signIn(codexHome, name) {
  await fsp.writeFile(path.join(codexHome, "auth.json"), oauthAuth(name));
  await addAccount(codexHome);
}

async function owners(codexHome) {
  const { threads } = await readThreadOwners(codexHome);
  return Object.fromEntries(Object.entries(threads).map(([id, owner]) => [id, `${owner.account.split("|")[1].split("::")[0]}/${owner.via}`]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A time strictly after everything before it and before everything after it,
// like the turns Codex records between two cx runs.
async function moment() {
  await sleep(3);
  const at = Date.now();
  await sleep(3);
  return at;
}

test("lastActivityMs finds the latest turn across read chunks and ignores other lines", async (t) => {
  const codexHome = await makeHome(t);
  const filePath = path.join(codexHome, "rollout.jsonl");
  const big = "x".repeat(600 * 1024);
  await fsp.writeFile(filePath, [meta("a"), turn(1000), reply(1001, big), turn(2000), reply(2001, big), reply(3000, "\"task_started\"")].join("\n"));
  assert.equal(await lastActivityMs(filePath), 2000);

  await fsp.writeFile(filePath, `${meta("b")}\n${reply(5, big)}\n`);
  assert.equal(await lastActivityMs(filePath), null);
  assert.equal(await lastActivityMs(path.join(codexHome, "missing.jsonl")), null);
});

test("a switch credits the threads used since the last one to the outgoing account", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await putThread(codexHome, "used-by-one", { turns: [await moment()] });
  await putThread(codexHome, "old", { turns: [1000] });

  await runSwitch({ codexHome, identifier: "two@example.com" });
  assert.deepEqual(await owners(codexHome), { "used-by-one": "one/activity" });
});

test("resuming another account's thread moves it to the account using it", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await putThread(codexHome, "shared", { turns: [await moment()] });
  await putThread(codexHome, "only-one", { turns: [await moment()] });
  await runSwitch({ codexHome, identifier: "two@example.com" });

  await resume(codexHome, "shared", await moment());
  await putThread(codexHome, "new-in-two", { turns: [await moment()] });
  const view = await loadSessions(codexHome);
  assert.deepEqual(await owners(codexHome), {
    shared: "two/activity",
    "only-one": "one/activity",
    "new-in-two": "two/activity"
  });
  assert.deepEqual(view.entries.filter((entry) => entry.owner).map((entry) => entry.thread.id).sort(), ["new-in-two", "only-one", "shared"]);
});

test("creator tags name the owner of threads outside a known window and beat a broken one", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  // Created long ago by two and still tagged: no window covers it.
  await putThread(codexHome, "tagged-old", { turns: [1000], creator: "two" });
  // Created in one's window, but by two: auth.json was swapped behind cx.
  await putThread(codexHome, "tagged-new", { turns: [await moment()], creator: "two" });
  await putThread(codexHome, "untagged-old", { turns: [1000] });

  await loadSessions(codexHome);
  assert.deepEqual(await owners(codexHome), { "tagged-old": "two/tag", "tagged-new": "two/tag" });
});

test("threads used while auth.json holds another login than the active account are not credited by time", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await fsp.writeFile(path.join(codexHome, "auth.json"), oauthAuth("stranger"));
  await putThread(codexHome, "unknown", { turns: [await moment()] });

  await loadSessions(codexHome);
  assert.deepEqual(await owners(codexHome), {});
});

function linkSubAgent(codexHome, parent, child) {
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, 'closed')").run(parent, child);
  db.close();
}

const planIds = (plan) => plan.groups.map((group) => group.members.map((member) => member.thread.id));

test("selectSessions refuses another account's ids and groups sub-agent threads under their root", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await putThread(codexHome, "parent-1111", { turns: [await moment()] });
  await putThread(codexHome, "child-2222", { turns: [await moment()] });
  await putThread(codexHome, "orphan-3333", { turns: [1000] });
  linkSubAgent(codexHome, "parent-1111", "child-2222");

  const view = await loadSessions(codexHome);
  const one = view.registry.active_account_key;
  assert.deepEqual(planIds(selectSessions(view, { accountKey: one, ids: ["parent"] })), [["parent-1111", "child-2222"]]);
  assert.deepEqual(planIds(selectSessions(view, { accountKey: one, ids: ["child"] })), [["child-2222"]]);
  assert.deepEqual(planIds(selectSessions(view, { accountKey: one, all: true })), [["parent-1111", "child-2222"]]);
  assert.throws(() => selectSessions(view, { accountKey: one, ids: ["orphan"] }), /Not this account's session/);
  assert.throws(() => selectSessions(view, { accountKey: one, ids: ["zz"] }), /too short/);
  assert.deepEqual(planIds(selectSessions(view, { accountKey: null })), [["orphan-3333"]]);
});

test("a session whose sub-agent thread has another owner is left alone, since codex delete would take it along", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await putThread(codexHome, "parent", { turns: [await moment()] });
  await putThread(codexHome, "child", { turns: [1000] });
  linkSubAgent(codexHome, "parent", "child");

  const view = await loadSessions(codexHome);
  const plan = selectSessions(view, { accountKey: view.registry.active_account_key, all: true });
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.blocked, [{ id: "parent", others: ["child"] }]);
});

test("an id prefix only has to be unique among the account's own sessions", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "one");
  await putThread(codexHome, "01a1f743-own", { turns: [await moment()] });
  await putThread(codexHome, "01a1f7c9-unassigned", { turns: [1000] });

  const view = await loadSessions(codexHome);
  assert.deepEqual(planIds(selectSessions(view, { accountKey: view.registry.active_account_key, ids: ["01a1f7"] })), [["01a1f743-own"]]);
  assert.throws(() => selectSessions(view, { accountKey: view.registry.active_account_key, ids: ["01a1f7c9"] }), /Not this account's session/);
});

test("cx sessions assign holds until the session is used again", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await putThread(codexHome, "given", { turns: [await moment()] });
  const view = await loadSessions(codexHome);
  assert.deepEqual(await owners(codexHome), { given: "one/activity" });
  const two = view.registry.accounts.find((account) => account.email === "two@example.com").account_key;

  await assignSessions(codexHome, two, ["given"]);
  await loadSessions(codexHome);
  assert.deepEqual(await owners(codexHome), { given: "two/manual" });

  await resume(codexHome, "given", await moment());
  await loadSessions(codexHome);
  assert.deepEqual(await owners(codexHome), { given: "one/activity" });
});

test("a creator tag names the owner of a session whose recorded owner was removed", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await putThread(codexHome, "tagged", { turns: [1000], creator: "two" });
  await fsp.writeFile(path.join(codexHome, "accounts", "threads.json"), JSON.stringify({
    version: 1,
    threads: { tagged: { account: "auth0|gone::account-gone", via: "activity", at: 1 } }
  }));

  await loadSessions(codexHome);
  assert.deepEqual(await owners(codexHome), { tagged: "two/tag" });
});

test("cx add credits the threads used with an API key before signing in to another account", async (t) => {
  const codexHome = await makeHome(t);
  const authPath = path.join(codexHome, "auth.json");
  await fsp.writeFile(authPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" }));
  await addAccount(codexHome, "key");
  await putThread(codexHome, "with-key", { turns: [await moment()] });

  await addAccountWithLogin(codexHome, undefined, { runCodex: () => fsp.writeFile(authPath, oauthAuth("two")) });
  const { threads } = await readThreadOwners(codexHome);
  assert.deepEqual(threads["with-key"] && [threads["with-key"].account, threads["with-key"].via], ["manual::key", "activity"]);
});

test("a whole-second updated_at doesn't hide a thread used in the second its account was activated", async (t) => {
  const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), "cx-sessions-seconds-"));
  t.after(() => fsp.rm(codexHome, { recursive: true, force: true }));
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)");
  db.prepare("INSERT INTO threads VALUES ('a', '/nowhere', 1700000000, 1700000000)").run();
  db.close();
  const [row] = await readThreadRows(codexHome);
  assert.equal(row.updatedAtMs, 1700000000999);
  assert.equal(row.createdAtMs, 1700000000000);
});

/** Deletes a thread the way `codex delete` does, as far as cx can see. */
async function fakeCodexDelete(codexHome, id) {
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id);
  db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  db.close();
  await fsp.rm(String(row.rollout_path), { force: true });
}

test("deleteSessions removes the threads, their prompts and leftovers, and only what is still the account's", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "two");
  await signIn(codexHome, "one");
  await putThread(codexHome, "gone", { turns: [await moment()] });
  await putThread(codexHome, "moved", { turns: [await moment()] });
  await putThread(codexHome, "keep", { turns: [await moment()] });
  await fsp.writeFile(path.join(codexHome, "history.jsonl"), [
    JSON.stringify({ session_id: "gone", ts: 1, text: "secret" }),
    JSON.stringify({ session_id: "keep", ts: 2, text: "kept" }),
    ""
  ].join("\n"), { mode: 0o600 });
  await fsp.mkdir(path.join(codexHome, "shell_snapshots"));
  await fsp.writeFile(path.join(codexHome, "shell_snapshots", "gone.123.sh"), "");
  await fsp.writeFile(path.join(codexHome, "shell_snapshots", "keep.456.sh"), "");

  const view = await loadSessions(codexHome);
  const one = view.registry.active_account_key;
  // "moved" is used by two after the list was shown.
  await runSwitch({ codexHome, identifier: "two@example.com" });
  await resume(codexHome, "moved", await moment());
  const result = await deleteSessions(codexHome, { accountKey: one, ids: ["gone", "moved"] }, { deleteThread: fakeCodexDelete });

  assert.deepEqual(result.deleted, ["gone"]);
  assert.deepEqual(result.moved, ["moved"]);
  assert.equal(result.cleanup.historyLinesRemoved, 1);
  assert.equal(result.cleanup.error, null);
  assert.equal(await fsp.readFile(path.join(codexHome, "history.jsonl"), "utf8"), `${JSON.stringify({ session_id: "keep", ts: 2, text: "kept" })}\n`);
  assert.deepEqual(await fsp.readdir(path.join(codexHome, "shell_snapshots")), ["keep.456.sh"]);
  assert.deepEqual(Object.keys(await owners(codexHome)).sort(), ["keep", "moved"]);
});

/** Like fakeCodexDelete, also deleting the sub-agent threads under it, as codex delete 0.171 does. */
async function fakeCascadingDelete(codexHome, id) {
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  const children = db.prepare("SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?").all(id).map((row) => row.child_thread_id);
  db.prepare("DELETE FROM thread_spawn_edges WHERE parent_thread_id = ?").run(id);
  db.close();
  for (const child of children) {
    await fakeCascadingDelete(codexHome, child);
  }
  await fakeCodexDelete(codexHome, id);
}

test("deleting a session with sub-agent threads works whether or not codex delete takes them along", async (t) => {
  for (const [name, deleteThread] of [["cascading", fakeCascadingDelete], ["non-cascading", fakeCodexDelete]]) {
    await t.test(name, async (t) => {
      const codexHome = await makeHome(t);
      await signIn(codexHome, "one");
      await putThread(codexHome, "parent", { turns: [await moment()] });
      await putThread(codexHome, "child", { turns: [await moment()] });
      await putThread(codexHome, "grandchild", { turns: [await moment()] });
      linkSubAgent(codexHome, "parent", "child");
      linkSubAgent(codexHome, "child", "grandchild");
      const calls = [];

      const view = await loadSessions(codexHome);
      const result = await deleteSessions(codexHome, { accountKey: view.registry.active_account_key, ids: ["parent", "child", "grandchild"] }, {
        deleteThread: async (home, id) => {
          calls.push(id);
          await deleteThread(home, id);
        }
      });
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.deleted, ["parent", "child", "grandchild"]);
      assert.deepEqual(calls, name === "cascading" ? ["parent"] : ["parent", "child", "grandchild"]);
    });
  }
});

test("prompts a delete couldn't remove are removed by a later cleanup", async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "one");
  await putThread(codexHome, "gone", { turns: [await moment()] });
  const historyPath = path.join(codexHome, "history.jsonl");
  // A directory where history.jsonl should be: reading it fails.
  await fsp.mkdir(historyPath);

  const view = await loadSessions(codexHome);
  const result = await deleteSessions(codexHome, { accountKey: view.registry.active_account_key, ids: ["gone"] }, { deleteThread: fakeCodexDelete });
  assert.deepEqual(result.deleted, ["gone"]);
  assert.ok(result.cleanup.error);
  assert.deepEqual((await readThreadOwners(codexHome)).pending_cleanup, ["gone"]);

  await fsp.rmdir(historyPath);
  await fsp.writeFile(historyPath, `${JSON.stringify({ session_id: "gone", ts: 1, text: "secret" })}\n`);
  const cleanup = await finishSessionCleanup(codexHome);
  assert.deepEqual(cleanup, { sessions: 1, historyLinesRemoved: 1, error: null });
  assert.equal(await fsp.readFile(historyPath, "utf8"), "");
  assert.equal((await readThreadOwners(codexHome)).pending_cleanup, undefined);
});

test("deleteSessions skips a thread whose rollout another process has open", { skip: process.platform !== "linux" }, async (t) => {
  const codexHome = await makeHome(t);
  await signIn(codexHome, "one");
  const rolloutPath = await putThread(codexHome, "busy", { turns: [await moment()] });
  const fd = fs.openSync(rolloutPath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", fd, "ignore"] });
  fs.closeSync(fd);
  t.after(() => child.kill());
  await new Promise((resolve) => child.once("spawn", resolve));

  const view = await loadSessions(codexHome);
  const result = await deleteSessions(codexHome, { accountKey: view.registry.active_account_key, ids: ["busy"] }, { deleteThread: fakeCodexDelete });
  assert.deepEqual(result.inUse, ["busy"]);
  assert.ok(fs.existsSync(rolloutPath));
});

// A codex stand-in for `codex delete`, deleting like fakeCodexDelete.
const fakeCodex = `#!/bin/sh
[ "$1" = "delete" ] || exit 1
if [ "$2" = "--help" ]; then echo "  --force  Delete without prompting"; exit 0; fi
exec "${process.execPath}" --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const db = new DatabaseSync(process.env.CODEX_HOME + "/state_5.sqlite");
const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(process.argv[1]);
if (!row) { console.error("Error: no such session"); process.exit(1); }
db.prepare("DELETE FROM threads WHERE id = ?").run(process.argv[1]);
fs.rmSync(row.rollout_path, { force: true });
console.log("Deleted session " + process.argv[1] + ".");
' "$3"
`;

test("cx sessions lists by account, and cx sessions delete asks before deleting", { skip: process.platform === "win32" ? "uses a POSIX shell stand-in for codex" : false }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cx-sessions-cli-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const fakeDir = path.join(root, "bin");
  await fsp.mkdir(fakeDir, { recursive: true });
  await fsp.writeFile(path.join(fakeDir, "codex"), fakeCodex, { mode: 0o755 });
  await fsp.mkdir(path.dirname(codexHome), { recursive: true });
  await fsp.rename(await makeHome(t), codexHome);
  await signIn(codexHome, "one");
  await putThread(codexHome, "aaaa-1", { turns: [await moment()], title: "first\nthread\u001b[2J" });
  await putThread(codexHome, "bbbb-2", { turns: [1000] });
  const run = (...args) => execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: home, PATH: `${fakeDir}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8"
  });

  const summary = await run("sessions");
  assert.match(summary.stdout, /one@example\.com\s+\|\s+1\s+\|/);
  assert.match(summary.stdout, /\(unassigned\)\s+\|\s+1\s+\|/);
  const listed = (await run("sessions", "one")).stdout;
  assert.match(listed, /aaaa-1 .*activity .*first thread \[2J/);
  assert.ok(!listed.includes("\u001b"));

  const dry = await run("sessions", "delete", "--unassigned", "--dry-run");
  assert.match(dry.stdout, /bbbb-2/);
  assert.match(dry.stdout, /nothing was deleted/);
  await assert.rejects(run("sessions", "delete", "one", "aaaa"), /Re-run in a TTY to confirm, or pass --yes/);
  await assert.rejects(run("sessions", "delete", "one", "bbbb", "--yes"), /Not this account's session/);

  const deleted = await run("sessions", "delete", "one", "--all", "--yes");
  assert.match(deleted.stdout, /Deleted 1 session/);
  assert.ok(!fs.existsSync(path.join(codexHome, "sessions", "rollout-aaaa-1.jsonl")));
  assert.match((await run("sessions", "assign", "one", "bbbb")).stdout, /Assigned 1 session/);
  assert.match((await run("sessions", "one")).stdout, /bbbb-2 .*manual/);
});
