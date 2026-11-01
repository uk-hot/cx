import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.js");

async function makeHome(t, accounts, activeKey) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-cli-list-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const accountsDir = path.join(home, ".codex", "accounts");
  await fs.mkdir(accountsDir, { recursive: true });
  if (accounts) {
    await fs.writeFile(
      path.join(accountsDir, "registry.json"),
      JSON.stringify({ schema_version: 3, active_account_key: activeKey, accounts }),
      "utf8"
    );
  }
  return home;
}

function runCli(home, args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8"
  });
}

test("list shows only the registered accounts", async (t) => {
  const home = await makeHome(t, [
    { account_key: "u1::a1", email: "alice@example.com", alias: "", provider: "openai" },
    { account_key: "u2::a2", email: "bob@example.com", alias: "work", provider: "openai" },
    { account_key: "u3::a3", email: null, alias: "personal", provider: "any-main" }
  ], "u2::a2");

  const { stdout } = await runCli(home, ["list"]);
  assert.match(stdout, /Registered accounts \(3\):/);
  assert.match(stdout, /\* bob@example\.com\s+openai\s+\(active\)/);
  assert.match(stdout, /alice@example\.com\s+openai/);
  assert.match(stdout, /personal\s+any-main/);
  assert.doesNotMatch(stdout, /Providers:|providers,/);
});

test("list with no accounts", async (t) => {
  const home = await makeHome(t, null, null);
  const { stdout } = await runCli(home, ["list"]);
  assert.match(stdout, /No registered accounts/);
});

test("remove refuses a partial match without a TTY", async (t) => {
  const home = await makeHome(t, [
    { account_key: "u1::a1", email: "homework@example.com", alias: "", provider: "openai" }
  ], null);

  await assert.rejects(runCli(home, ["remove", "work"]), (error) => /only partially matches/.test(error.stderr));
  const registry = JSON.parse(await fs.readFile(path.join(home, ".codex", "accounts", "registry.json"), "utf8"));
  assert.equal(registry.accounts.length, 1);

  const { stdout } = await runCli(home, ["remove", "homework@example.com"]);
  assert.match(stdout, /^Removed account: homework@example\.com/);
});
