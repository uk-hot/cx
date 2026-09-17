import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.js");

test("add registers a manual account", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cx-cli-add-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const codexHome = path.join(home, ".codex");
  await fs.mkdir(codexHome);
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    "model_provider = \"third-party\"\n",
    "utf8"
  );

  const env = { ...process.env, HOME: home };
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "add", "third-party"], {
    env,
    encoding: "utf8"
  });
  assert.match(stdout, /^Added account:/);

  const registry = JSON.parse(
    await fs.readFile(path.join(codexHome, "accounts", "registry.json"), "utf8")
  );
  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.accounts[0].account_key, "manual::third-party");

});
