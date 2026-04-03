import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { readRegistry, saveAccount, useAccount } from "../src/auth-service.js";
import { acquireLock } from "../src/locking.js";
import { getStatus, renderStatus, runSwitch, runSync } from "../src/service.js";
import { applySessionChanges, collectSessionChanges, restoreSessionChanges } from "../src/session-files.js";

async function makeTempCodexHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-provider-sync-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(path.join(codexHome, "sessions", "2026", "03", "19"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "archived_sessions", "2026", "03", "18"), { recursive: true });
  return { root, codexHome };
}

async function writeRollout(filePath, id, provider) {
  const payload = {
    id,
    timestamp: "2026-03-19T00:00:00.000Z",
    cwd: "C:\\AITemp",
    source: "cli",
    cli_version: "0.115.0",
    model_provider: provider
  };
  const lines = [
    JSON.stringify({ timestamp: payload.timestamp, type: "session_meta", payload }),
    JSON.stringify({ timestamp: payload.timestamp, type: "event_msg", payload: { type: "user_message", message: "hi" } })
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeConfig(codexHome, modelProviderLine = "") {
  const config = `${modelProviderLine}${modelProviderLine ? "\n" : ""}sandbox_mode = "danger-full-access"\n\n[model_providers.apigather]\nbase_url = "https://example.com"\n`;
  await fs.writeFile(path.join(codexHome, "config.toml"), config, "utf8");
}

function makeFakeIdToken(sub, email) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, email, exp: 9999999999 })).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

function makeFakeAuthJson({ userId, accountId, email }) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeFakeIdToken(userId, email),
      access_token: "fake-access-token",
      refresh_token: "rt_fake",
      account_id: accountId
    },
    last_refresh: new Date().toISOString()
  };
}

async function writeAuthJson(codexHome, authData) {
  await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify(authData, null, 2), "utf8");
}

async function writeStateDb(codexHome, rows) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        model_provider TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        first_user_message TEXT NOT NULL DEFAULT ''
      )
    `);
    const stmt = db.prepare("INSERT INTO threads (id, model_provider, archived, first_user_message) VALUES (?, ?, ?, ?)");
    for (const row of rows) {
      stmt.run(row.id, row.model_provider, row.archived ? 1 : 0, row.first_user_message ?? "hello");
    }
  } finally {
    db.close();
  }
}

async function lockRolloutFile(filePath, shareMode = "None") {
  const script = `
& {
  param([string]$path, [string]$shareMode)
  $share = [System.Enum]::Parse([System.IO.FileShare], $shareMode)
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, $share)
  try {
    Write-Output 'locked'
    [Console]::Out.Flush()
    Start-Sleep -Seconds 30
  } finally {
    $stream.Close()
  }
}
`.trim();

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    filePath,
    shareMode
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (!settled && stdout.includes("locked")) {
        settled = true;
        resolve();
      }
    });

    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to acquire rollout file lock. Exit code: ${code ?? "null"}, signal: ${signal ?? "null"}`));
      }
    });
  });

  return child;
}

async function runCli(args, options = {}) {
  const cliPath = path.resolve("src", "cli.js");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        ...(options.homeDir ? { HOME: options.homeDir } : {}),
        ...(options.env ?? {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function runCliInTty(args, options = {}) {
  const cliPath = path.resolve("src", "cli.js");
  const command = [process.execPath, cliPath, ...args].map(shellQuote).join(" ");
  return await new Promise((resolve, reject) => {
    const child = spawn("script", ["-qefc", command, "/dev/null"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        ...(options.homeDir ? { HOME: options.homeDir } : {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let interactionIndex = 0;

    const maybeSendInteraction = () => {
      if (!options.interactions || interactionIndex >= options.interactions.length) {
        return;
      }
      const normalizedStdout = stdout.replace(/\r/g, "");
      const interaction = options.interactions[interactionIndex];
      if (!interaction.when.test(normalizedStdout)) {
        return;
      }
      child.stdin.write(interaction.write);
      interactionIndex += 1;
      if (interactionIndex >= options.interactions.length) {
        child.stdin.end();
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      maybeSendInteraction();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({
        code,
        stdout: stdout.replace(/\r/g, ""),
        stderr: stderr.replace(/\r/g, "")
      });
    });

    if (!options.interactions) {
      child.stdin.end(options.input ?? "");
    }
  });
}

test("runSync rewrites rollout files and sqlite without creating backup snapshots", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeRollout(archivedPath, "thread-b", "newapi");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false },
    { id: "thread-b", model_provider: "newapi", archived: true }
  ]);

  const syncResult = await runSync({ codexHome });
  assert.equal(syncResult.targetProvider, "openai");
  assert.equal(syncResult.changedSessionFiles, 2);
  assert.deepEqual(syncResult.skippedLockedRolloutFiles, []);
  assert.equal(syncResult.sqliteRowsUpdated, 2);

  const syncedSession = await fs.readFile(sessionPath, "utf8");
  const syncedArchived = await fs.readFile(archivedPath, "utf8");
  assert.match(syncedSession, /"model_provider":"openai"/);
  assert.match(syncedArchived, /"model_provider":"openai"/);

  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    const providers = db
      .prepare("SELECT id, model_provider FROM threads ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(providers, [
      { id: "thread-a", model_provider: "openai" },
      { id: "thread-b", model_provider: "openai" }
    ]);
  } finally {
    db.close();
  }

  await assert.rejects(() => fs.access(path.join(codexHome, "backups_state")));
});

test("runSwitch restores profile and syncs provider metadata", async () => {
  const { codexHome } = await makeTempCodexHome();
  // Start with openai config
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false }
  ]);

  // Prepare a saved profile with apigather config
  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir, { recursive: true });
  const apigatherConfig = `model_provider = "apigather"\nsandbox_mode = "danger-full-access"\n\n[model_providers.apigather]\nbase_url = "https://example.com"\n`;
  const accountKey = "manual::apigather";
  const configFilename = Buffer.from(accountKey, "utf8").toString("base64").replace(/=+$/, "") + ".config.toml";
  await fs.writeFile(path.join(accountsDir, configFilename), apigatherConfig, "utf8");
  await fs.writeFile(path.join(accountsDir, "registry.json"), JSON.stringify({
    schema_version: 3,
    active_account_key: null,
    accounts: [{
      account_key: accountKey,
      email: null,
      alias: "apigather",
      provider: "apigather",
      auth_mode: "manual"
    }]
  }), "utf8");

  const fakeUseAccount = async (home, identifier) => {
    // Simulate useAccount: restore config.toml
    await fs.copyFile(path.join(accountsDir, configFilename), path.join(home, "config.toml"));
    return { accountKey, email: null, alias: "apigather", provider: "apigather" };
  };

  const result = await runSwitch({ codexHome, identifier: "apigather", useAccountFn: fakeUseAccount });
  assert.equal(result.targetProvider, "apigather");

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "apigather"/m);
  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);
});

test("runSwitch restores config, auth, and registry when sync fails after switching to a manual account", async () => {
  const { codexHome } = await makeTempCodexHome();
  const authPath = path.join(codexHome, "auth.json");

  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  const openaiAccount = await saveAccount(codexHome, "openai-main");
  const originalAuthText = await fs.readFile(authPath, "utf8");

  await fs.rm(authPath, { force: true });
  await writeConfig(codexHome, 'model_provider = "owl"');
  await saveAccount(codexHome, "owl");
  await useAccount(codexHome, "openai@example.com");

  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false }
  ]);

  const lockDb = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      () => runSwitch({ codexHome, identifier: "owl", useAccountFn: useAccount }),
      /state_5\.sqlite is currently in use/
    );
  } finally {
    try {
      lockDb.exec("ROLLBACK");
    } catch {
      // Ignore cleanup failures in tests.
    }
    lockDb.close();
  }

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "openai"/m);
  assert.equal(await fs.readFile(authPath, "utf8"), originalAuthText);

  const registry = await readRegistry(codexHome);
  assert.equal(registry.active_account_key, openaiAccount.accountKey);
});

test("runSwitch removes auth.json again when sync fails after switching from manual to OAuth", async () => {
  const { codexHome } = await makeTempCodexHome();
  const authPath = path.join(codexHome, "auth.json");

  await writeConfig(codexHome, 'model_provider = "owl"');
  const manualAccount = await saveAccount(codexHome, "owl");
  await fs.rm(authPath, { force: true });

  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "openai-main");

  await fs.rm(authPath, { force: true });
  await useAccount(codexHome, "owl");

  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "owl", archived: false }
  ]);

  const lockDb = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      () => runSwitch({ codexHome, identifier: "openai@example.com", useAccountFn: useAccount }),
      /state_5\.sqlite is currently in use/
    );
  } finally {
    try {
      lockDb.exec("ROLLBACK");
    } catch {
      // Ignore cleanup failures in tests.
    }
    lockDb.close();
  }

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "owl"/m);
  await assert.rejects(() => fs.access(authPath));

  const registry = await readRegistry(codexHome);
  assert.equal(registry.active_account_key, manualAccount.accountKey);
});

test("cli switch restores profile and syncs session visibility", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");

  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "openai-main");

  await fs.rm(path.join(codexHome, "auth.json"), { force: true });
  await writeConfig(codexHome, 'model_provider = "apigather"');
  await saveAccount(codexHome, "apigather");

  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false }
  ]);

  const result = await runCli(["switch", "apigather"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Switched account: apigather \[apigather]/);
  assert.match(result.stdout, /Updated rollout files: 1/);
  assert.match(result.stdout, /Updated SQLite rows: 1/);
  assert.equal(result.stderr.trim(), "");

  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /^model_provider = "apigather"/m);
  await assert.rejects(() => fs.access(path.join(codexHome, "auth.json")));

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    const row = db.prepare("SELECT model_provider FROM threads WHERE id = ?").get("thread-a");
    assert.equal(row.model_provider, "apigather");
  } finally {
    db.close();
  }
});

test("cli save snapshots current profile with the renamed command", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "apigather"');

  const result = await runCli(["save", "apigather"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Saved account: manual::apigather \(alias: apigather\)/);

  const registry = JSON.parse(await fs.readFile(path.join(codexHome, "accounts", "registry.json"), "utf8"));
  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.accounts[0].alias, "apigather");
  assert.equal(registry.accounts[0].provider, "apigather");
});

test("cli remove deletes a saved profile with the renamed command", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "apigather"');
  await saveAccount(codexHome, "apigather");

  const result = await runCli(["remove", "gath"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Removed account: manual::apigather/);

  const registry = JSON.parse(await fs.readFile(path.join(codexHome, "accounts", "registry.json"), "utf8"));
  assert.equal(registry.accounts.length, 0);
});

test("cli switch accepts a unique fuzzy match", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");

  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "openai-main");

  await fs.rm(path.join(codexHome, "auth.json"), { force: true });
  await writeConfig(codexHome, 'model_provider = "apigather"');
  await saveAccount(codexHome, "apigather");

  await writeRollout(sessionPath, "thread-a", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "openai", archived: false }
  ]);

  const result = await runCli(["switch", "gath"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Switched account: apigather \[apigather]/);
});

test("cli switch and remove reject ambiguous fuzzy matches without a TTY", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "alice@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "alice-main");

  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-2",
    accountId: "acc-2",
    email: "alex@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "alex-main");

  const switchResult = await runCli(["switch", "al"], { homeDir: root });
  assert.equal(switchResult.code, 1);
  assert.match(switchResult.stderr, /Multiple saved accounts match "al"\. Re-run in a TTY to choose one\./);

  const removeResult = await runCli(["remove", "al"], { homeDir: root });
  assert.equal(removeResult.code, 1);
  assert.match(removeResult.stderr, /Multiple saved accounts match "al"\. Re-run in a TTY to choose one\./);
});

test("cli switch and remove TTY prompts omit alias suffix for OAuth accounts", async () => {
  if (process.platform === "win32") {
    return;
  }

  const switchHome = await makeTempCodexHome();
  await writeAuthJson(switchHome.codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "alice@example.com"
  }));
  await writeConfig(switchHome.codexHome, 'model_provider = "openai"');
  await saveAccount(switchHome.codexHome, "alice-main");

  await writeAuthJson(switchHome.codexHome, makeFakeAuthJson({
    userId: "user-2",
    accountId: "acc-2",
    email: "alex@example.com"
  }));
  await writeConfig(switchHome.codexHome, 'model_provider = "openai"');
  await saveAccount(switchHome.codexHome, "alex-main");

  const switchResult = await runCliInTty(["switch", "al"], {
    homeDir: switchHome.root,
    interactions: [
      { when: /Select account to switch \[1-2\] \(or q to cancel\): /, write: "1\n" },
      { when: /Switch to alice@example\.com \[openai\]\? \[y\/N\] /, write: "y\n" }
    ]
  });
  assert.equal(switchResult.code, 0);
  assert.match(switchResult.stdout, /Multiple accounts match "al":/);
  assert.match(switchResult.stdout, /1\. alice@example\.com \[openai\]/);
  assert.match(switchResult.stdout, /2\. alex@example\.com \[openai\]/);
  assert.match(switchResult.stdout, /Switch to alice@example\.com \[openai\]\? \[y\/N\]/);
  assert.doesNotMatch(switchResult.stdout, /\(alice-main\)|\(alex-main\)/);

  const removeHome = await makeTempCodexHome();
  await writeAuthJson(removeHome.codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "alice@example.com"
  }));
  await writeConfig(removeHome.codexHome, 'model_provider = "openai"');
  await saveAccount(removeHome.codexHome, "alice-main");

  await writeAuthJson(removeHome.codexHome, makeFakeAuthJson({
    userId: "user-2",
    accountId: "acc-2",
    email: "alex@example.com"
  }));
  await writeConfig(removeHome.codexHome, 'model_provider = "openai"');
  await saveAccount(removeHome.codexHome, "alex-main");

  const removeResult = await runCliInTty(["remove", "al"], {
    homeDir: removeHome.root,
    interactions: [
      { when: /Select account to remove \[1-2\] \(or q to cancel\): /, write: "2\n" },
      { when: /Remove alex@example\.com \[openai\]\? \[y\/N\] /, write: "y\n" }
    ]
  });
  assert.equal(removeResult.code, 0);
  assert.match(removeResult.stdout, /Multiple accounts match "al":/);
  assert.match(removeResult.stdout, /Remove alex@example\.com \[openai\]\? \[y\/N\]/);
  assert.doesNotMatch(removeResult.stdout, /\(alice-main\)|\(alex-main\)/);
});

test("cli rejects removed auth-save, auth-list, and auth-remove commands", async () => {
  for (const args of [
    ["auth-save", "apigather"],
    ["auth-list"],
    ["auth-remove", "apigather"]
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`Unknown command: ${args[0]}`));
  }
});

test("cli rejects removed auth-use command", async () => {
  const result = await runCli(["auth-use", "legacy"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: auth-use/);
});

test("cli rejects removed auth-current command", async () => {
  const result = await runCli(["auth-current"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: auth-current/);
});

test("cli rejects removed restore command", async () => {
  const result = await runCli(["restore", "/tmp/backup"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: restore/);
});

test("cli rejects removed prune-backups command", async () => {
  const result = await runCli(["prune-backups"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: prune-backups/);
});

test("cli rejects removed sync command", async () => {
  const result = await runCli(["sync"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: sync/);
});

test("cli rejects removed --codex-home option", async () => {
  const result = await runCli(["status", "--codex-home", "/root/.codex"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The --codex-home option has been removed/);
});

test("cli rejects unknown options and extra positionals", async () => {
  const unknownFlag = await runCli(["usage", "--provider", "openai"]);
  assert.equal(unknownFlag.code, 1);
  assert.match(unknownFlag.stderr, /Unknown option for usage: --provider/);

  const extraArgs = await runCli(["status", "extra"]);
  assert.equal(extraArgs.code, 1);
  assert.match(extraArgs.stderr, /Too many arguments\. Usage: cx status/);

  const rootUnknownFlag = await runCli(["--heldfdfdp"]);
  assert.equal(rootUnknownFlag.code, 1);
  assert.match(rootUnknownFlag.stderr, /Unknown option: --heldfdfdp/);
});

test("cli help does not load sqlite-backed commands", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /cx switch <email\|alias>/);
  assert.doesNotMatch(result.stdout, /cx sync/);
  assert.doesNotMatch(result.stdout, /cx usage/);
  assert.doesNotMatch(result.stdout, /auth-use/);
  assert.doesNotMatch(result.stdout, /prune-backups/);
  assert.doesNotMatch(result.stdout, /restore <backup-dir>/);
  assert.doesNotMatch(result.stdout, /codex-home/);
  assert.equal(result.stderr.trim(), "");
});

test("cli list marks the current profile and does not emit sqlite warning", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "main");

  const result = await runCli(["list"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ACCOUNT\s+PROVIDER\s+PLAN\s+5H USAGE\s+WEEKLY USAGE\s+LAST ACTIVITY/);
  assert.match(result.stdout, /\* openai@example\.com\s+openai\s+-\s+-\s+-\s+-/);
  assert.equal(result.stderr.trim(), "");
});

test("cli list syncs the active account from auth.json before rendering", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "main");

  await fs.rm(path.join(codexHome, "auth.json"), { force: true });
  await writeConfig(codexHome, 'model_provider = "owl"');
  await saveAccount(codexHome, "owl");

  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));

  const result = await runCli(["list"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /\* openai@example\.com\s+openai\s+/);
  assert.doesNotMatch(result.stdout, /\* owl\s+/);
});

test("cli list refreshes ChatGPT usage before rendering accounts", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "main");

  const registryPath = path.join(codexHome, "accounts", "registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  registry.accounts[0].last_usage = {
    primary: { used_percent: 25, window_minutes: 300, resets_at: 9999999999 },
    secondary: { used_percent: 10, window_minutes: 10080, resets_at: 9999999999 },
    plan_type: "pro"
  };
  registry.accounts[0].last_usage_at = Math.floor(Date.now() / 1000) - (16 * 3600);
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  const fetchLogPath = path.join(root, "usage-fetch.log");
  const mockImportPath = pathToFileURL(path.resolve("test", "mock-usage-fetch.js")).href;
  const result = await runCli(["list"], {
    homeDir: root,
    env: {
      NODE_OPTIONS: `--import=${mockImportPath}`,
      CX_TEST_USAGE_FETCH_LOG: fetchLogPath,
      CX_TEST_USAGE_FETCH_RESPONSE: JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 9999999999 },
          secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 9999999999 }
        }
      })
    }
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\* openai@example\.com\s+openai\s+pro\s+/);
  assert.match(result.stdout, /\bNow\b/);
  assert.equal(await fs.readFile(fetchLogPath, "utf8"), "acc-1\n");
});

test("cli usage renders the active ChatGPT account as a table", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "main");
  const registryPath = path.join(codexHome, "accounts", "registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  registry.accounts[0].last_usage = {
    primary: { used_percent: 25, window_minutes: 300, resets_at: 9999999999 },
    secondary: { used_percent: 10, window_minutes: 10080, resets_at: 9999999999 },
    plan_type: "pro"
  };
  registry.accounts[0].last_usage_at = Math.floor(Date.now() / 1000);
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  const result = await runCli(["usage"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ACCOUNT\s+PROVIDER\s+PLAN\s+5H USAGE\s+WEEKLY USAGE\s+LAST ACTIVITY/);
  assert.match(result.stdout, /\* openai@example\.com\s+openai\s+pro\s+/);
  assert.equal(result.stderr.trim(), "");
});

test("cli usage shows saved ChatGPT accounts when the active account is third-party", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({
    userId: "user-1",
    accountId: "acc-1",
    email: "openai@example.com"
  }));
  await writeConfig(codexHome, 'model_provider = "openai"');
  await saveAccount(codexHome, "main");

  const registryPath = path.join(codexHome, "accounts", "registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  registry.accounts[0].last_usage = {
    primary: { used_percent: 25, window_minutes: 300, resets_at: 9999999999 },
    secondary: { used_percent: 10, window_minutes: 10080, resets_at: 9999999999 },
    plan_type: "pro"
  };
  registry.accounts[0].last_usage_at = Math.floor(Date.now() / 1000);
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), "utf8");

  await fs.rm(path.join(codexHome, "auth.json"), { force: true });
  await writeConfig(codexHome, 'model_provider = "owl"');
  await saveAccount(codexHome, "owl");

  const result = await runCli(["usage"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ACCOUNT\s+PROVIDER\s+PLAN\s+5H USAGE\s+WEEKLY USAGE\s+LAST ACTIVITY/);
  assert.match(result.stdout, /\* openai@example\.com\s+openai\s+pro\s+/);
  assert.equal(result.stderr.trim(), "");
});

test("status reports implicit default provider and rollout/sqlite counts", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const archivedPath = path.join(codexHome, "archived_sessions", "2026", "03", "18", "rollout-b.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeRollout(archivedPath, "thread-b", "openai");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false },
    { id: "thread-b", model_provider: "openai", archived: true }
  ]);

  const status = await getStatus({ codexHome });
  assert.equal(status.currentProvider, "openai");
  assert.equal(status.currentProviderImplicit, true);
  assert.deepEqual(status.rolloutCounts.sessions, { apigather: 1 });
  assert.deepEqual(status.sqliteCounts.archived_sessions, { openai: 1 });
  assert.equal("backupSummary" in status, false);
  assert.equal("backupRoot" in status, false);
});

test("renderStatus formats status as tables", () => {
  const output = renderStatus({
    currentProvider: "openai",
    currentProviderImplicit: true,
    rolloutCounts: {
      sessions: { openai: 2 },
      archived_sessions: {}
    },
    sqliteCounts: null
  });

  assert.match(output, /STATUS/);
  assert.match(output, /\|\s+FIELD\s+\|\s+VALUE\s+\|/);
  assert.match(output, /\|\s+Current provider\s+\|\s+openai \(implicit default\)\s+\|/);
  assert.doesNotMatch(output, /Configured providers/);
  assert.doesNotMatch(output, /Codex home/);
  assert.doesNotMatch(output, /SQLite database/);
  assert.match(output, /ROLLOUT FILES/);
  assert.match(output, /\|\s+sessions\s+\|\s+openai\s+\|\s+2\s+\|/);
  assert.match(output, /SQLITE STATE/);
  assert.match(output, /\|\s+database\s+\|\s+state_5\.sqlite not found\s+\|\s+-\s+\|/);
});

test("cli status renders tables", async () => {
  const { root, codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "openai");

  const result = await runCli(["status"], { homeDir: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /STATUS/);
  assert.match(result.stdout, /\|\s+FIELD\s+\|\s+VALUE\s+\|/);
  assert.match(result.stdout, /ROLLOUT FILES/);
  assert.match(result.stdout, /SQLITE STATE/);
  assert.equal(result.stderr.trim(), "");
});

test("runSwitch rejects missing identifier", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome);
  await assert.rejects(
    () => runSwitch({ codexHome, identifier: null, useAccountFn: async () => {} }),
    /Missing account identifier/
  );
});

test("runSync leaves rollout files and sqlite untouched when sqlite is locked", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  const lockDb = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    await assert.rejects(
      () => runSync({ codexHome, sqliteBusyTimeoutMs: 0 }),
      /state_5\.sqlite is currently in use/
    );
  } finally {
    try {
      lockDb.exec("ROLLBACK");
    } catch {
      // Ignore cleanup failures in tests.
    }
    lockDb.close();
  }

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    const row = db
      .prepare("SELECT model_provider FROM threads WHERE id = ?")
      .get("thread-a");
    assert.equal(row.model_provider, "apigather");
  } finally {
    db.close();
  }
});

test("runSync skips locked rollout files and still updates sqlite", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  const lockProcess = await lockRolloutFile(sessionPath);
  let result;
  try {
    result = await runSync({ codexHome, sqliteBusyTimeoutMs: 0 });
  } finally {
    lockProcess.kill();
    await new Promise((resolve) => lockProcess.once("exit", resolve));
  }

  assert.equal(result.changedSessionFiles, 0);
  assert.equal(result.sqliteRowsUpdated, 1);
  assert.deepEqual(result.skippedLockedRolloutFiles, [sessionPath]);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);

  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    const row = db
      .prepare("SELECT model_provider FROM threads WHERE id = ?")
      .get("thread-a");
    assert.equal(row.model_provider, "openai");
  } finally {
    db.close();
  }
});

test("applySessionChanges skips rollout files that changed after collection", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");

  const { changes } = await collectSessionChanges(codexHome, "openai");
  await fs.appendFile(
    sessionPath,
    '{"timestamp":"2026-03-19T00:00:01.000Z","type":"event_msg","payload":{"type":"assistant_message","message":"later"}}\n',
    "utf8"
  );

  const result = await applySessionChanges(changes);
  assert.equal(result.appliedChanges, 0);
  assert.deepEqual(result.skippedPaths, [sessionPath]);

  const rollout = await fs.readFile(sessionPath, "utf8");
  assert.match(rollout, /"model_provider":"apigather"/);
  assert.match(rollout, /"message":"later"/);
});

test("restoreSessionChanges keeps restoring files after one restore fails", async () => {
  const { codexHome } = await makeTempCodexHome();
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  const missingPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-missing.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");

  const originalRollout = await fs.readFile(sessionPath, "utf8");
  const originalLines = originalRollout.split("\n");
  const originalFirstLine = originalLines[0];
  const updatedFirstLine = originalFirstLine.replace('"model_provider":"apigather"', '"model_provider":"openai"');
  await fs.writeFile(sessionPath, `${updatedFirstLine}\n${originalLines.slice(1).join("\n")}`, "utf8");

  await assert.rejects(
    () => restoreSessionChanges([
      {
        path: missingPath,
        originalFirstLine,
        originalSeparator: "\n"
      },
      {
        path: sessionPath,
        originalFirstLine,
        originalSeparator: "\n"
      }
    ]),
    /Failed to restore 1 rollout file\(s\)/
  );

  assert.equal(await fs.readFile(sessionPath, "utf8"), originalRollout);
});

test("acquireLock recovers a stale lock owned by a dead process", async () => {
  const { codexHome } = await makeTempCodexHome();
  const lockDir = path.join(codexHome, "tmp", "provider-sync.lock");
  await fs.mkdir(lockDir, { recursive: true });
  await fs.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
    pid: 2147483647,
    startedAt: "2026-03-19T00:00:00.000Z",
    label: "stale",
    cwd: process.cwd()
  }, null, 2), "utf8");

  const releaseLock = await acquireLock(codexHome, "sync");
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lockDir, "owner.json"), "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.label, "sync");
  } finally {
    await releaseLock();
  }

  await assert.rejects(() => fs.access(lockDir));
});

test("acquireLock does not break a live lock", async () => {
  const { codexHome } = await makeTempCodexHome();
  const releaseLock = await acquireLock(codexHome, "sync");
  try {
    await assert.rejects(
      () => acquireLock(codexHome, "second"),
      /Lock already exists/
    );
  } finally {
    await releaseLock();
  }
});

test("runSync does not create backup directories", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfig(codexHome, 'model_provider = "openai"');
  const sessionPath = path.join(codexHome, "sessions", "2026", "03", "19", "rollout-a.jsonl");
  await writeRollout(sessionPath, "thread-a", "apigather");
  await writeStateDb(codexHome, [
    { id: "thread-a", model_provider: "apigather", archived: false }
  ]);

  await runSync({ codexHome });
  await assert.rejects(() => fs.access(path.join(codexHome, "backups_state")));
});
