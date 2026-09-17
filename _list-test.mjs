import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "cx-list-test-"));

function writeRegistry(home, accounts, activeKey) {
  const dir = path.join(home, ".codex", "accounts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "registry.json"),
    JSON.stringify({ schema_version: 3, active_account_key: activeKey, accounts }),
    "utf8"
  );
}

const runCli = (home, args) =>
  execFileSync("node", ["src/cli.js", ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });

// TEST 1: 账号清单正常,且不再有 provider 汇总行
{
  const home = mkHome();
  writeRegistry(home, [
    { account_key: "u1::a1", email: "alice@example.com", alias: "", provider: "openai" },
    { account_key: "u2::a2", email: "bob@example.com", alias: "work", provider: "openai" },
    { account_key: "u3::a3", email: null, alias: "personal", provider: "any-main" }
  ], "u2::a2");
  const out = runCli(home, ["list"]);
  assert.match(out, /Registered accounts \(3\):/);
  assert.match(out, /\* bob@example\.com\s+openai\s+\(active\)/);
  assert.match(out, /alice@example\.com\s+openai/);
  assert.match(out, /personal\s+any-main/); // email 为 null 回退 alias;provider 列保留
  assert.doesNotMatch(out, /Providers:/, "不应再出现 provider 汇总行");
  assert.doesNotMatch(out, /providers,/, "不应再出现 (N providers, M accounts)");
  console.log("TEST 1 (listing only, no summary) PASS\n" + out);
}

// TEST 2: 无账号
{
  const home = mkHome();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const out = runCli(home, ["list"]);
  assert.match(out, /No registered accounts/);
  console.log("TEST 2 (empty) PASS");
}

console.log("\nALL LIST TESTS PASSED");
