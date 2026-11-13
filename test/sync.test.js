import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { runSync } from "../src/service.js";

function sessionMeta(id, provider) {
  return JSON.stringify({ type: "session_meta", payload: { id, model_provider: provider } });
}

async function makeCodexHome(t, threads) {
  const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), "cx-sync-"));
  t.after(() => fsp.rm(codexHome, { recursive: true, force: true }));
  const dir = path.join(codexHome, "sessions", "2026", "10", "31");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"any\"\n", "utf8");

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
  const db = new Database(path.join(codexHome, "state_5.sqlite"), { readonly: true });
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
  assert.equal(result.targetProvider, "any");
  assert.equal(result.changedSessionFiles, 2);
  assert.equal(result.sqliteRowsUpdated, 2);
  assert.deepEqual(readProviders(codexHome), { a: "any", b: "any" });
  for (const filePath of Object.values(files)) {
    assert.equal((await fsp.stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await fsp.readFile(filePath, "utf8")).split("\n")[1], "{\"n\":1}");
  }
});

test("sync skips rollouts another process has open and leaves their rows alone", { skip: process.platform !== "linux" }, async (t) => {
  const { codexHome, files } = await makeCodexHome(t, ["busy", "idle"]);
  await holdOpen(t, files.busy);
  const inodeBefore = (await fsp.stat(files.busy)).ino;

  const result = await runSync({ codexHome });
  assert.deepEqual(result.skippedLockedRolloutFiles, [files.busy]);
  assert.equal(result.changedSessionFiles, 1);
  assert.deepEqual(readProviders(codexHome), { busy: "openai", idle: "any" });
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

  const check = new Database(path.join(codexHome, "state_5.sqlite"), { readonly: true });
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

test("sync leaves the creator of a skipped rollout in place", { skip: process.platform !== "linux" }, async (t) => {
  const { codexHome, files } = await makeCodexHome(t, ["busy"]);
  const header = JSON.stringify({ type: "session_meta", payload: { account_scoped: true, creator_account_id: "acct-a", id: "busy", model_provider: "openai" } });
  await fsp.writeFile(files.busy, `${header}\n{"n":1}\n`, { mode: 0o600 });
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec("ALTER TABLE threads ADD COLUMN creator_user_id TEXT; ALTER TABLE threads ADD COLUMN creator_account_id TEXT");
  db.prepare("UPDATE threads SET creator_account_id = 'acct-a', model_provider = 'any'").run();
  db.close();
  await holdOpen(t, files.busy);

  const result = await runSync({ codexHome });
  assert.deepEqual(result.skippedLockedRolloutFiles, [files.busy]);
  assert.equal(result.sqliteRowsUpdated, 0);
  const check = new Database(path.join(codexHome, "state_5.sqlite"), { readonly: true });
  try {
    assert.equal(check.prepare("SELECT creator_account_id FROM threads WHERE id = 'busy'").get().creator_account_id, "acct-a");
  } finally {
    check.close();
  }
  assert.match(await fsp.readFile(files.busy, "utf8"), /"account_scoped":true/);
});
