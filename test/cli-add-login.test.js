import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

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

const apiKeyAuth = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });

// A codex stand-in that records how it started, then "signs in" with FAKE_LOGIN_AUTH.
const fakeCodex = `#!/bin/sh
printf '%s\\n' "$*" > "$FAKE_DIR/args"
printf '%s\\n' "$CODEX_HOME" > "$FAKE_DIR/codex-home"
[ -e "$CODEX_HOME/auth.json" ] && touch "$FAKE_DIR/saw-auth"
[ -n "$FAKE_BEFORE_EXIT" ] && eval "$FAKE_BEFORE_EXIT"
[ -f "$FAKE_LOGIN_AUTH" ] && cp "$FAKE_LOGIN_AUTH" "$CODEX_HOME/auth.json"
exit "\${FAKE_EXIT:-0}"
`;

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cx-add-login-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const home = path.join(root, "home");
  const fakeDir = path.join(root, "fake");
  const codexHome = path.join(home, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(fakeDir);
  await fs.writeFile(path.join(fakeDir, "codex"), fakeCodex, { mode: 0o755 });

  const loginAuthPath = path.join(fakeDir, "login-auth.json");
  const authPath = path.join(codexHome, "auth.json");
  const accountsDir = path.join(codexHome, "accounts");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`,
    FAKE_DIR: fakeDir,
    FAKE_LOGIN_AUTH: loginAuthPath
  };

  return {
    env,
    codexHome,
    authPath,
    loginAuthPath,
    fakeDir,
    run: (args, extraEnv = {}) => execFileAsync(process.execPath, [cliPath, ...args], {
      env: { ...env, ...extraEnv },
      encoding: "utf8"
    }),
    readRegistry: async () => JSON.parse(await fs.readFile(path.join(accountsDir, "registry.json"), "utf8")),
    readAuth: () => fs.readFile(authPath, "utf8"),
    readSnapshots: async () => Promise.all(
      (await fs.readdir(accountsDir))
        .filter((name) => name.endsWith(".auth.json"))
        .map((name) => fs.readFile(path.join(accountsDir, name), "utf8"))
    ),
    codexWasRun: () => fs.access(path.join(fakeDir, "args")).then(() => true, () => false)
  };
}

test("add saves the current account and signs in through Codex", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("new"));

  const { stdout } = await ctx.run(["add", "work"]);
  assert.match(stdout, /^Saved current account: old@example\.com$/m);
  assert.match(stdout, /^Added account: new@example\.com \(alias: work\)$/m);

  assert.equal((await fs.readFile(path.join(ctx.fakeDir, "args"), "utf8")).trim(), "--no-daemon");
  assert.equal((await fs.readFile(path.join(ctx.fakeDir, "codex-home"), "utf8")).trim(), ctx.codexHome);
  await assert.rejects(fs.access(path.join(ctx.fakeDir, "saw-auth")), /ENOENT/, "codex must not see the old login");

  assert.equal(await ctx.readAuth(), oauthAuth("new"));
  const registry = await ctx.readRegistry();
  assert.deepEqual(
    registry.accounts.map((account) => [account.email, account.alias]),
    [["old@example.com", ""], ["new@example.com", "work"]]
  );
  assert.equal(registry.active_account_key, "user-new::account-new");
  assert.deepEqual((await ctx.readSnapshots()).sort(), [oauthAuth("new"), oauthAuth("old")].sort());
});

test("codex always uses the home cx manages", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("new"));

  await ctx.run(["add"], { CODEX_HOME: path.join(ctx.fakeDir, "elsewhere") });
  assert.equal((await fs.readFile(path.join(ctx.fakeDir, "codex-home"), "utf8")).trim(), ctx.codexHome);
});

test("add signs in on a machine with nothing to save", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("new"));

  const { stdout } = await ctx.run(["add"]);
  assert.doesNotMatch(stdout, /Saved current account/);
  assert.match(stdout, /^Added account: new@example\.com$/m);
  assert.equal((await ctx.readRegistry()).accounts.length, 1);
});

for (const [name, extraEnv] of [
  ["a clean exit", {}],
  ["a failed exit", { FAKE_EXIT: "3" }]
]) {
  test(`${name} without a login restores the current account`, { skip }, async (t) => {
    const ctx = await setup(t);
    await fs.writeFile(ctx.authPath, oauthAuth("old"));

    await assert.rejects(ctx.run(["add"], extraEnv), /No login was completed/);
    assert.equal(await ctx.readAuth(), oauthAuth("old"));
    assert.deepEqual((await ctx.readRegistry()).accounts.map((account) => account.email), ["old@example.com"]);
    assert.equal((await fs.stat(ctx.authPath)).mode & 0o777, 0o600);
  });
}

test("a login is kept even when Codex exits with an error", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("new"));

  const { stdout } = await ctx.run(["add"], { FAKE_EXIT: "1" });
  assert.match(stdout, /^Added account: new@example\.com$/m);
  assert.equal(await ctx.readAuth(), oauthAuth("new"));
});

test("a missing codex command restores the current account", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));
  await fs.rm(path.join(ctx.fakeDir, "codex"));

  await assert.rejects(ctx.run(["add"], { PATH: ctx.fakeDir }), /codex command was not found/);
  assert.equal(await ctx.readAuth(), oauthAuth("old"));
});

test("add refuses to replace an API-key login it cannot save", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, apiKeyAuth);
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("new"));

  await assert.rejects(ctx.run(["add"]), /Provide an alias: cx add <alias>/);
  assert.equal(await ctx.codexWasRun(), false);
  assert.equal(await ctx.readAuth(), apiKeyAuth);
});

test("add signs in once an API-key login has been saved", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, apiKeyAuth);
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("new"));

  await ctx.run(["add", "key"]);
  assert.equal(await ctx.codexWasRun(), false);

  const { stdout } = await ctx.run(["add"]);
  assert.match(stdout, /^Added account: new@example\.com$/m);
  assert.deepEqual(
    (await ctx.readRegistry()).accounts.map((account) => account.account_key),
    ["manual::key", "user-new::account-new"]
  );
});

test("choosing an API key in Codex registers it under the alias", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));
  await fs.writeFile(ctx.loginAuthPath, apiKeyAuth);

  const { stdout } = await ctx.run(["add", "key"]);
  assert.match(stdout, /^Added account: manual::key \(alias: key\)$/m);
  assert.equal(await ctx.readAuth(), apiKeyAuth);
});

test("choosing an API key without an alias keeps it and asks for one", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));
  await fs.writeFile(ctx.loginAuthPath, apiKeyAuth);

  await assert.rejects(ctx.run(["add"]), /Provide an alias: cx add <alias>/);
  assert.equal(await ctx.readAuth(), apiKeyAuth);

  await fs.rm(path.join(ctx.fakeDir, "args"));
  await ctx.run(["add", "key"]);
  assert.equal(await ctx.codexWasRun(), false);
  assert.ok((await ctx.readRegistry()).accounts.some((account) => account.account_key === "manual::key"));
});

test("choosing a provider without auth.json in Codex registers it under the alias", { skip }, async (t) => {
  const ctx = await setup(t);
  const configPath = path.join(ctx.codexHome, "config.toml");
  await fs.writeFile(ctx.authPath, oauthAuth("old"));

  await ctx.run(["add", "cloud"], {
    FAKE_BEFORE_EXIT: `printf 'model_provider = "bedrock"\\n' > "${configPath}"`
  });

  const accounts = (await ctx.readRegistry()).accounts;
  assert.deepEqual(accounts.at(-1).account_key, "manual::cloud");
  assert.equal(accounts.at(-1).provider, "bedrock");
  await assert.rejects(ctx.readAuth(), /ENOENT/);
});

test("signing in to the same account refreshes it without adding a duplicate", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));
  const refreshed = JSON.stringify({ ...JSON.parse(oauthAuth("old")), last_refresh: "later" });
  await fs.writeFile(ctx.loginAuthPath, refreshed);

  const { stdout } = await ctx.run(["add"]);
  assert.match(stdout, /^Refreshed already registered account: old@example\.com$/m);
  assert.doesNotMatch(stdout, /^Added account/m);
  assert.equal((await ctx.readRegistry()).accounts.length, 1);
  assert.deepEqual(await ctx.readSnapshots(), [refreshed]);
});

test("closing the terminal stops Codex and restores the current account", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));

  const ready = path.join(ctx.fakeDir, "ready");
  const child = spawn(process.execPath, [cliPath, "add"], {
    env: { ...ctx.env, FAKE_BEFORE_EXIT: `touch "${ready}"; exec sleep 30` },
    stdio: "ignore"
  });
  const exited = once(child, "exit");
  while (!await fs.access(ready).then(() => true, () => false)) {
    await setTimeout(20);
  }

  child.kill("SIGHUP");
  const [code] = await exited;
  assert.equal(code, 1);
  assert.equal(await ctx.readAuth(), oauthAuth("old"));
});

test("a third-party provider never starts Codex", { skip }, async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(path.join(ctx.codexHome, "config.toml"), "model_provider = \"third-party\"\n");
  await fs.writeFile(ctx.authPath, oauthAuth("old"));

  await ctx.run(["add", "gateway"]);
  assert.equal(await ctx.codexWasRun(), false);
  assert.equal((await ctx.readRegistry()).accounts[0].account_key, "manual::gateway");
  assert.equal(await ctx.readAuth(), oauthAuth("old"));
});

// Registers "old" and "new", then removes "new" while Codex is still logged in to it.
async function setupRemovedLiveLogin(t) {
  const ctx = await setup(t);
  await fs.writeFile(ctx.authPath, oauthAuth("old"));
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("new"));
  await ctx.run(["add"]);
  await ctx.run(["remove", "new@example.com"]);
  await fs.rm(path.join(ctx.fakeDir, "args"));
  return ctx;
}

const accountEmails = async (ctx) => (await ctx.readRegistry()).accounts.map((account) => account.email);

test("add does not save a removed account that is still logged in", { skip }, async (t) => {
  const ctx = await setupRemovedLiveLogin(t);
  await fs.writeFile(ctx.loginAuthPath, oauthAuth("other"));

  const { stdout } = await ctx.run(["add"]);
  assert.doesNotMatch(stdout, /Saved current account/);
  assert.match(stdout, /^Added account: other@example\.com$/m);
  assert.deepEqual(await accountEmails(ctx), ["old@example.com", "other@example.com"]);
});

test("a cancelled add leaves a removed account out of the next switch", { skip }, async (t) => {
  const ctx = await setupRemovedLiveLogin(t);
  await fs.rm(ctx.loginAuthPath);

  await assert.rejects(ctx.run(["add"]), /No login was completed/);
  assert.equal(await ctx.readAuth(), oauthAuth("new"));

  await fs.writeFile(path.join(ctx.codexHome, "config.toml"), "model = \"gpt\"\n");
  await ctx.run(["switch", "old@example.com"]);
  assert.equal(await ctx.readAuth(), oauthAuth("old"));
  assert.deepEqual(await accountEmails(ctx), ["old@example.com"]);
});

test("signing in to a removed account adds it back", { skip }, async (t) => {
  const ctx = await setupRemovedLiveLogin(t);

  const { stdout } = await ctx.run(["add"]);
  assert.match(stdout, /^Added account: new@example\.com$/m);
  const registry = await ctx.readRegistry();
  assert.deepEqual(registry.accounts.map((account) => account.email), ["old@example.com", "new@example.com"]);
  assert.equal(registry.removed_account_key, undefined);
});
