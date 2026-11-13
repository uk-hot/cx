import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { accountKeyToConfigFilename } from "../src/registry.js";
import { restartCodexDaemon } from "../src/codex-daemon.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.js");
const skip = process.platform === "win32" ? "uses a POSIX shell stand-in for codex" : false;

function jwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function oauthAuth(name) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: `account-${name}`,
      id_token: jwt({ sub: `user-${name}`, email: `${name}@example.com` }),
      access_token: jwt({ sub: `user-${name}` }),
      refresh_token: `refresh-${name}`
    }
  });
}

// A codex stand-in: `app-server daemon <cmd>` behaves as FAKE_DAEMON says
// (running, broken = running but fails to restart, hang = doesn't answer,
// anything else = stopped) and is logged to daemon-calls; any other invocation
// "signs in". Restarting stops the process in holder.pid, like the real daemon
// closing the rollout files of its sessions.
const fakeCodex = `#!/bin/sh
if [ "$1" = "app-server" ]; then
  printf '%s %s\\n' "$3" "$CODEX_HOME" >> "$FAKE_DIR/daemon-calls"
  case "$FAKE_DAEMON:$3" in
    running:version|broken:version) echo '{"status":"running"}' ;;
    hang:version) sleep 5 ;;
    running:restart)
      if [ -f "$FAKE_DIR/holder.pid" ]; then
        pid=$(cat "$FAKE_DIR/holder.pid"); kill "$pid"; i=0
        while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
      fi
      echo '{"event":"process_spawned"}'; echo '{"status":"restarted"}' ;;
    broken:restart) echo 'Error: daemon did not come back' >&2; exit 1 ;;
    *) echo 'Error: failed to connect' >&2; exit 1 ;;
  esac
  exit 0
fi
[ -f "$FAKE_LOGIN_AUTH" ] && cp "$FAKE_LOGIN_AUTH" "$CODEX_HOME/auth.json"
exit 0
`;

// Two registered accounts, "new" active, "old" ready to switch back to.
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cx-daemon-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const home = path.join(root, "home");
  const fakeDir = path.join(root, "fake");
  const codexHome = path.join(home, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(fakeDir);
  await fs.writeFile(path.join(fakeDir, "codex"), fakeCodex, { mode: 0o755 });

  const authPath = path.join(codexHome, "auth.json");
  const loginAuthPath = path.join(fakeDir, "login-auth.json");
  const callsPath = path.join(fakeDir, "daemon-calls");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`,
    FAKE_DIR: fakeDir,
    FAKE_LOGIN_AUTH: loginAuthPath
  };
  const run = (args, daemon = "stopped") => execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...env, FAKE_DAEMON: daemon },
    encoding: "utf8"
  });

  await fs.writeFile(path.join(codexHome, "config.toml"), "model = \"gpt\"\n");
  await fs.writeFile(authPath, oauthAuth("old"));
  await fs.writeFile(loginAuthPath, oauthAuth("new"));
  await run(["add"]);
  await fs.rm(loginAuthPath);
  // Each test only looks at the daemon calls of its own command.
  await fs.rm(callsPath, { force: true });

  return {
    codexHome,
    authPath,
    loginAuthPath,
    fakeDir,
    env,
    run,
    daemonCalls: () => fs.readFile(callsPath, "utf8").then(
      (text) => text.trim().split("\n").map((line) => line.split(" ")),
      () => []
    )
  };
}

test("switch restarts a running daemon so it picks up the new login", { skip }, async (t) => {
  const ctx = await setup(t);

  const { stdout } = await ctx.run(["switch", "old@example.com"], "running");
  assert.equal(await fs.readFile(ctx.authPath, "utf8"), oauthAuth("old"));
  assert.match(stdout, /^Restarted the Codex app-server daemon/m);
  assert.deepEqual(await ctx.daemonCalls(), [["version", ctx.codexHome], ["restart", ctx.codexHome]]);
});

test("switch leaves a daemon that isn't running alone", { skip }, async (t) => {
  const ctx = await setup(t);

  const { stdout, stderr } = await ctx.run(["switch", "old@example.com"], "stopped");
  assert.doesNotMatch(stdout + stderr, /app-server daemon/);
  assert.deepEqual((await ctx.daemonCalls()).map(([command]) => command), ["version"]);
});

test("a failed restart only warns, because the switch already happened", { skip }, async (t) => {
  const ctx = await setup(t);

  const { stdout, stderr } = await ctx.run(["switch", "old@example.com"], "broken");
  assert.match(stdout, /^Switched account: old@example\.com/m);
  assert.match(stderr, /Could not restart the Codex app-server daemon \(Error: daemon did not come back\)/);
  assert.match(stderr, /codex app-server daemon restart/);
  assert.equal(await fs.readFile(ctx.authPath, "utf8"), oauthAuth("old"));
});

test("add restarts a running daemon after signing in", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("third"));

  const { stdout } = await ctx.run(["add"], "running");
  assert.match(stdout, /^Added account: third@example\.com$/m);
  assert.match(stdout, /^Restarted the Codex app-server daemon/m);
  assert.deepEqual((await ctx.daemonCalls()).map(([command]) => command), ["version", "restart"]);
});

test("refreshing an already registered account also restarts the daemon", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("old"));

  const { stdout } = await ctx.run(["add"], "running");
  assert.match(stdout, /^Refreshed already registered account: old@example\.com$/m);
  assert.match(stdout, /^Restarted the Codex app-server daemon/m);
});

test("adding a third-party provider leaves the daemon alone", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(path.join(ctx.codexHome, "config.toml"), "model_provider = \"gateway\"\n");

  const { stdout } = await ctx.run(["add", "gateway"], "running");
  assert.match(stdout, /^Added account: manual::gateway/m);
  assert.deepEqual(await ctx.daemonCalls(), []);
});

test("a daemon that doesn't answer is reported instead of skipped", { skip }, async (t) => {
  const ctx = await setup(t);
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  Object.assign(process.env, { PATH: ctx.env.PATH, FAKE_DIR: ctx.fakeDir, FAKE_DAEMON: "hang" });

  assert.deepEqual(
    await restartCodexDaemon(ctx.codexHome, { timeoutMs: 300 }),
    { status: "failed", detail: "timed out checking the daemon" }
  );
});

test("switch syncs the rollouts the daemon held open once it restarted", { skip: process.platform !== "linux" }, async (t) => {
  const ctx = await setup(t);
  // The account to switch to uses another provider, so its sessions need a rewrite.
  const oldConfig = path.join(ctx.codexHome, "accounts", accountKeyToConfigFilename("user-old::account-old"));
  await fs.writeFile(oldConfig, "model_provider = \"gateway\"\n");
  const rolloutDir = path.join(ctx.codexHome, "sessions", "2026", "11", "01");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rollout = path.join(rolloutDir, "rollout-open.jsonl");
  await fs.writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "open", model_provider: "openai" } })}\n`);

  const fd = fsSync.openSync(rollout, "a");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", fd, "ignore"] });
  fsSync.closeSync(fd);
  t.after(() => holder.kill());
  await once(holder, "spawn");
  await fs.writeFile(path.join(ctx.fakeDir, "holder.pid"), String(holder.pid));

  const { stdout } = await ctx.run(["switch", "old@example.com"], "running");
  assert.match(stdout, /^Skipped locked rollout files: 1$/m);
  assert.match(stdout, /^Re-synchronized provider: gateway$/m);
  const firstLine = (await fs.readFile(rollout, "utf8")).split("\n")[0];
  assert.equal(JSON.parse(firstLine).payload.model_provider, "gateway");
});
