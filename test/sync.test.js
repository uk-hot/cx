import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSync } from "../src/service.js";
import { loadDatabaseSync } from "../src/sqlite-state.js";

const Database = loadDatabaseSync();

function sessionMeta(id, provider) {
  return JSON.stringify({ type: "session_meta", payload: { id, model_provider: provider } });
}

// The default target provider is longer than "openai", so the headers grow and
// the rollouts are replaced, not rewritten in place.
async function makeCodexHome(t, threads, { provider = "gateway" } = {}) {
  const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), "cx-sync-"));
  t.after(() => fsp.rm(codexHome, { recursive: true, force: true }));
  const dir = path.join(codexHome, "sessions", "2026", "10", "31");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(codexHome, "config.toml"), `model_provider = "${provider}"\n`, "utf8");

  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)");
  const insert = db.prepare("INSERT INTO threads (id, rollout_path, model_provider) VALUES (?, ?, ?)");

  const files = {};
  for (const id of threads) {
    const filePath = path.join(dir, `rollout-${id}.jsonl`);
    await fsp.writeFile(filePath, `${sessionMeta(id, "openai")}\n{"n":1}\n`, { mode: 0o600 });
    insert.run(id, filePath, "openai");
    files[id] = filePath;
  }
  db.close();
  return { codexHome, files };
}

function readProviders(codexHome) {
  const db = new Database(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT id, model_provider FROM threads").all().map((row) => [row.id, row.model_provider]));
  } finally {
    db.close();
  }
}

// Holds the file open from another process, like a running Codex session.
async function holdOpen(t, filePath) {
  const fd = fs.openSync(filePath, "a");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", fd, "ignore"] });
  fs.closeSync(fd);
  t.after(() => child.kill());
  await new Promise((resolve) => child.once("spawn", resolve));
}

test("sync rewrites rollouts, keeps their mode and updates SQLite", async (t) => {
  const { codexHome, files } = await makeCodexHome(t, ["a", "b"]);

  const result = await runSync({ codexHome });
  assert.equal(result.targetProvider, "gateway");
  assert.equal(result.changedSessionFiles, 2);
  assert.equal(result.sqliteRowsUpdated, 2);
  assert.deepEqual(readProviders(codexHome), { a: "gateway", b: "gateway" });
  for (const filePath of Object.values(files)) {
    // Windows has no POSIX permission bits to keep.
    if (process.platform !== "win32") {
      assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);
    }
    assert.equal((await fsp.readFile(filePath, "utf8")).split("\n")[1], "{\"n\":1}");
  }
});

test("sync skips rollouts another process has open and leaves their rows alone", { skip: !["linux", "win32"].includes(process.platform) }, async (t) => {
  const { codexHome, files } = await makeCodexHome(t, ["busy", "idle"]);
  await holdOpen(t, files.busy);
  const inodeBefore = (await fsp.stat(files.busy)).ino;

  const result = await runSync({ codexHome });
  assert.deepEqual(result.skippedLockedRolloutFiles, [files.busy]);
  assert.equal(result.changedSessionFiles, 1);
  assert.deepEqual(readProviders(codexHome), { busy: "openai", idle: "gateway" });
  // The open file was not replaced, so the holder's later writes still land in it.
  assert.equal((await fsp.stat(files.busy)).ino, inodeBefore);
  assert.match(await fsp.readFile(files.busy, "utf8"), /"model_provider":"openai"/);
});

test("sync shares account-scoped threads with every account, including on the same provider", async (t) => {
  const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), "cx-sync-scope-"));
  t.after(() => fsp.rm(codexHome, { recursive: true, force: true }));
  const dir = path.join(codexHome, "sessions", "2026", "11", "13");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"openai\"\n", "utf8");

  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, creator_user_id TEXT, creator_account_id TEXT)");
  const insert = db.prepare("INSERT INTO threads (id, rollout_path, model_provider, creator_user_id, creator_account_id) VALUES (?, ?, ?, ?, ?)");
  const headers = {
    scoped: { account_scoped: true, creator_user_id: "user-a", creator_account_id: "acct-a", id: "scoped", model_provider: "openai", cwd: "/w" },
    tagged: { creator_user_id: "user-b", creator_account_id: "acct-b", id: "tagged", model_provider: "openai", cwd: "/w" },
    plain: { id: "plain", model_provider: "openai", cwd: "/w" }
  };
  const files = {};
  for (const [id, payload] of Object.entries(headers)) {
    files[id] = path.join(dir, `rollout-${id}.jsonl`);
    await fsp.writeFile(files[id], `${JSON.stringify({ type: "session_meta", payload })}\n{"n":1}\n`, { mode: 0o600 });
    insert.run(id, files[id], "openai", payload.creator_user_id ?? null, payload.creator_account_id ?? null);
  }
  db.close();
  const plainBefore = await fsp.readFile(files.plain, "utf8");

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 2);
  assert.equal(result.sqliteRowsUpdated, 2);
  for (const id of ["scoped", "tagged"]) {
    const [first, second] = (await fsp.readFile(files[id], "utf8")).split("\n");
    assert.deepEqual(JSON.parse(first).payload, { id, model_provider: "openai", cwd: "/w" });
    assert.equal(second, "{\"n\":1}");
  }
  assert.equal(await fsp.readFile(files.plain, "utf8"), plainBefore);

  const check = new Database(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
  try {
    assert.deepEqual(
      check.prepare("SELECT COUNT(*) AS n FROM threads WHERE creator_user_id IS NOT NULL OR creator_account_id IS NOT NULL").get().n,
      0
    );
  } finally {
    check.close();
  }

  const again = await runSync({ codexHome });
  assert.equal(again.changedSessionFiles, 0);
  assert.equal(again.sqliteRowsUpdated, 0);
});

test("sync leaves the creator of a skipped rollout in place", { skip: !["linux", "win32"].includes(process.platform) }, async (t) => {
  // Longer than the tags it removes, so the header grows and the open file is skipped.
  const { codexHome, files } = await makeCodexHome(t, ["busy"], { provider: `gateway-${"x".repeat(80)}` });
  const header = JSON.stringify({ type: "session_meta", payload: { account_scoped: true, creator_account_id: "acct-a", id: "busy", model_provider: "openai" } });
  await fsp.writeFile(files.busy, `${header}\n{"n":1}\n`, { mode: 0o600 });
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec("ALTER TABLE threads ADD COLUMN creator_user_id TEXT; ALTER TABLE threads ADD COLUMN creator_account_id TEXT");
  db.prepare("UPDATE threads SET creator_account_id = 'acct-a'").run();
  db.close();
  await holdOpen(t, files.busy);

  const result = await runSync({ codexHome });
  assert.deepEqual(result.skippedLockedRolloutFiles, [files.busy]);
  assert.equal(result.sqliteRowsUpdated, 0);
  const check = new Database(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
  try {
    assert.equal(check.prepare("SELECT creator_account_id FROM threads WHERE id = 'busy'").get().creator_account_id, "acct-a");
  } finally {
    check.close();
  }
  assert.match(await fsp.readFile(files.busy, "utf8"), /"account_scoped":true/);
});

test("sync skips a rollout whose thread writer lock Codex holds open", { skip: !["linux", "win32"].includes(process.platform) }, async (t) => {
  const thread = "01a1d42f-359d-7b20-b275-64ee4b89d2e9";
  const idle = "01a1d4c4-bb04-7822-85e4-e0f9f716220c";
  const { codexHome, files } = await makeCodexHome(t, [thread, idle]);
  const lockDir = path.join(codexHome, "thread-writer-locks");
  await fsp.mkdir(lockDir);
  // A lock left behind by a Codex that exited is not held open.
  await fsp.writeFile(path.join(lockDir, `${idle}.lock`), "");
  const lockPath = path.join(lockDir, `${thread}.lock`);
  await fsp.writeFile(lockPath, "");
  await holdOpen(t, lockPath);

  const result = await runSync({ codexHome });
  assert.deepEqual(result.skippedLockedRolloutFiles, [files[thread]]);
  assert.equal(result.changedSessionFiles, 1);
  assert.deepEqual(readProviders(codexHome), { [thread]: "openai", [idle]: "gateway" });
});

// Codex 0.171+ records byte offsets into rollouts (paginated history, forks),
// so a header that fits is overwritten in place with the same byte length.
async function makeScopedHome(t, headers, provider) {
  const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), "cx-sync-inplace-"));
  t.after(() => fsp.rm(codexHome, { recursive: true, force: true }));
  const dir = path.join(codexHome, "sessions", "2026", "11", "20");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(codexHome, "config.toml"), `model_provider = "${provider}"\n`, "utf8");
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, creator_user_id TEXT, creator_account_id TEXT)");
  const insert = db.prepare("INSERT INTO threads (id, rollout_path, model_provider, creator_user_id, creator_account_id) VALUES (?, ?, ?, ?, ?)");
  const files = {};
  for (const payload of headers) {
    files[payload.id] = path.join(dir, `rollout-${payload.id}.jsonl`);
    await fsp.writeFile(files[payload.id], `${JSON.stringify({ type: "session_meta", payload })}\n{"n":1}\n{"n":2}\n`, { mode: 0o600 });
    insert.run(payload.id, files[payload.id], payload.model_provider, payload.creator_user_id ?? null, payload.creator_account_id ?? null);
  }
  db.close();
  return { codexHome, files };
}

function readRow(codexHome, id) {
  const db = new Database(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
  try {
    return { ...db.prepare("SELECT model_provider, creator_user_id, creator_account_id FROM threads WHERE id = ?").get(id) };
  } finally {
    db.close();
  }
}

const scopedHeader = (id, extra = {}) => ({
  account_scoped: true,
  creator_user_id: "user-7nHuV3yM5ZgFadsZnzOb0RWh",
  creator_account_id: "baf22b9e-1942-46e0-85fc-418ec19a4dfb",
  id,
  model_provider: "openai",
  cwd: "/w",
  history_mode: "paginated",
  ...extra
});

test("sync rewrites a header that fits in place, keeping the file's size and byte offsets", async (t) => {
  const { codexHome, files } = await makeScopedHome(t, [scopedHeader("paged")], "openai");
  const before = await fsp.readFile(files.paged);
  const { ino } = await fsp.stat(files.paged);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 1);
  assert.deepEqual(result.oversizedRolloutFiles, []);
  const after = await fsp.readFile(files.paged);
  assert.equal(after.length, before.length);
  assert.equal(after.indexOf(0x0a), before.indexOf(0x0a));
  assert.equal(after.subarray(before.indexOf(0x0a)).toString(), before.subarray(before.indexOf(0x0a)).toString());
  assert.equal((await fsp.stat(files.paged)).ino, ino);
  const firstLine = after.toString("utf8").split("\n")[0];
  assert.match(firstLine, / +$/);
  assert.deepEqual(JSON.parse(firstLine).payload, { id: "paged", model_provider: "openai", cwd: "/w", history_mode: "paginated" });
  assert.deepEqual(readRow(codexHome, "paged"), { model_provider: "openai", creator_user_id: null, creator_account_id: null });

  // The padded header needs nothing more, and its room lets a later switch stay in place.
  assert.equal((await runSync({ codexHome })).changedSessionFiles, 0);
  await fsp.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"gateway\"\n", "utf8");
  assert.equal((await runSync({ codexHome })).changedSessionFiles, 1);
  assert.equal((await fsp.readFile(files.paged)).length, before.length);
  assert.equal(JSON.parse((await fsp.readFile(files.paged, "utf8")).split("\n")[0]).payload.model_provider, "gateway");
});

test("sync rewrites an open rollout in place without losing what its writer appends", { skip: process.platform === "win32" ? "an open file can't be opened exclusively" : false }, async (t) => {
  const live = "01a1f90a-1624-7543-a87a-4087365fe66b";
  const { codexHome, files } = await makeScopedHome(t, [scopedHeader(live)], "openai");
  const lockDir = path.join(codexHome, "thread-writer-locks");
  await fsp.mkdir(lockDir);
  const lockPath = path.join(lockDir, `${live}.lock`);
  await fsp.writeFile(lockPath, "");
  await holdOpen(t, lockPath);
  const writer = fs.openSync(files[live], "a");
  t.after(() => fs.closeSync(writer));
  await holdOpen(t, files[live]);

  const result = await runSync({ codexHome });
  assert.deepEqual(result.skippedLockedRolloutFiles, []);
  assert.deepEqual(result.liveRolloutFiles, [files[live]]);
  assert.equal(result.changedSessionFiles, 1);
  assert.equal(readRow(codexHome, live).creator_account_id, null);

  fs.writeSync(writer, "{\"n\":3}\n");
  const lines = (await fsp.readFile(files[live], "utf8")).split("\n");
  assert.equal(JSON.parse(lines[0]).payload.account_scoped, undefined);
  assert.deepEqual(lines.slice(1), ["{\"n\":1}", "{\"n\":2}", "{\"n\":3}", ""]);
});

test("sync leaves a header with invalid UTF-8 alone instead of writing past it", async (t) => {
  const { codexHome, files } = await makeScopedHome(t, [scopedHeader("bad", { cwd: "/w/X" })], "openai");
  // A lone 0xff byte in place of "X" decodes to U+FFFD, two bytes longer.
  const bytes = await fsp.readFile(files.bad);
  bytes[bytes.indexOf(Buffer.from("/w/X")) + 3] = 0xff;
  await fsp.writeFile(files.bad, bytes);

  const result = await runSync({ codexHome });
  assert.equal(result.changedSessionFiles, 0);
  assert.deepEqual(await fsp.readFile(files.bad), bytes);
});

test("sync treats a thread paginated only in SQLite as addressed by byte offset", async (t) => {
  const { codexHome, files } = await makeScopedHome(t, [
    { id: "promoted", model_provider: "openai" },
    { id: "projected", model_provider: "openai" },
    { id: "legacy", model_provider: "openai" }
  ], "gateway");
  const state = new Database(path.join(codexHome, "state_5.sqlite"));
  state.exec("ALTER TABLE threads ADD COLUMN history_mode TEXT NOT NULL DEFAULT 'legacy'; UPDATE threads SET history_mode = 'paginated' WHERE id = 'promoted'");
  // Codex may store the path differently (a symlinked home): the id still matches.
  state.exec("UPDATE threads SET rollout_path = '/elsewhere/rollout-promoted.jsonl' WHERE id = 'promoted'");
  state.close();
  const history = new Database(path.join(codexHome, "thread_history_1.sqlite"));
  history.exec("CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL); INSERT INTO thread_history_projection_state VALUES ('projected', 0, 0)");
  history.close();
  const before = await fsp.readFile(files.promoted, "utf8");

  const result = await runSync({ codexHome });
  assert.deepEqual(result.oversizedRolloutFiles, [files.projected, files.promoted].sort());
  assert.equal(result.changedSessionFiles, 1);
  assert.equal(await fsp.readFile(files.promoted, "utf8"), before);
  assert.equal(readRow(codexHome, "promoted").model_provider, "openai");
  assert.equal(readRow(codexHome, "projected").model_provider, "openai");
  assert.equal(readRow(codexHome, "legacy").model_provider, "gateway");
});

test("sync leaves a rollout Codex addresses by byte offset when its header would grow", async (t) => {
  const { codexHome, files } = await makeScopedHome(t, [
    { id: "paged", model_provider: "openai", history_mode: "paginated" },
    { id: "parent", model_provider: "openai" },
    { id: "fork", model_provider: "openai", history_base: { thread_id: "parent", end_byte_offset: 10 }, account_scoped: true, creator_account_id: "baf22b9e-1942-46e0-85fc-418ec19a4dfb" },
    { id: "legacy", model_provider: "openai" }
  ], "gateway");
  const before = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([id, file]) => [id, await fsp.readFile(file, "utf8")])));

  const result = await runSync({ codexHome });
  assert.deepEqual(result.oversizedRolloutFiles, [files.paged, files.parent].sort());
  // The fork's header fits once its tags are gone; a legacy rollout may still grow.
  assert.equal(result.changedSessionFiles, 2);
  assert.equal(await fsp.readFile(files.paged, "utf8"), before.paged);
  assert.equal(await fsp.readFile(files.parent, "utf8"), before.parent);
  assert.equal((await fsp.readFile(files.fork, "utf8")).length, before.fork.length);
  assert.match(await fsp.readFile(files.legacy, "utf8"), /"model_provider":"gateway"/);
  assert.equal(readRow(codexHome, "paged").model_provider, "openai");
  assert.equal(readRow(codexHome, "parent").model_provider, "openai");
  assert.deepEqual(readRow(codexHome, "fork"), { model_provider: "gateway", creator_user_id: null, creator_account_id: null });
});
