import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addAccount, useAccount } from "../src/accounts.js";
import { getStatus, runSwitch } from "../src/service.js";

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

// "one" is registered; "two" is logged in but not registered yet.
async function setup(t, prefix) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const authPath = path.join(codexHome, "auth.json");
  await fs.writeFile(authPath, oauthAuth("one"));
  await addAccount(codexHome);
  await fs.writeFile(authPath, oauthAuth("two"));
  return { codexHome, authPath, accountsDir: path.join(codexHome, "accounts") };
}

async function readDir(dirPath) {
  const entries = {};
  for (const name of (await fs.readdir(dirPath)).sort()) {
    const filePath = path.join(dirPath, name);
    entries[name] = { text: await fs.readFile(filePath, "utf8"), mode: (await fs.stat(filePath)).mode & 0o777 };
  }
  return entries;
}

test("switch and status work without config.toml", async (t) => {
  const { codexHome, authPath } = await setup(t, "cx-switch-noconfig-");

  const result = await runSwitch({ codexHome, identifier: "one@example.com" });
  assert.equal(result.targetProvider, "openai");
  assert.equal(await fs.readFile(authPath, "utf8"), oauthAuth("one"));
  assert.equal((await getStatus({ codexHome })).currentProvider, "openai");
});

test("a failed switch restores auth, config and every account file", async (t) => {
  const { codexHome, authPath, accountsDir } = await setup(t, "cx-switch-rollback-");
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(configPath, "model = \"gpt\"\n", { mode: 0o644 });
  await fs.chmod(configPath, 0o644);
  const accountsBefore = await readDir(accountsDir);

  // useAccount registers "two" (new snapshot files) before replacing auth.json.
  await assert.rejects(runSwitch({
    codexHome,
    identifier: "one@example.com",
    useAccountFn: async (home, identifier) => {
      await useAccount(home, identifier);
      throw new Error("sync failed");
    }
  }), /sync failed/);

  assert.equal(await fs.readFile(authPath, "utf8"), oauthAuth("two"));
  assert.equal(await fs.readFile(configPath, "utf8"), "model = \"gpt\"\n");
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o644);
  assert.deepEqual(await readDir(accountsDir), accountsBefore);
});
