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
