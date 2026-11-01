import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  accountKeyToConfigFilename,
  accountKeyToFilename,
  addAccount,
  syncActiveAccountFromCurrentAuth,
  useAccount
} from "../src/auth-service.js";

function jwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function oauthAuth({ userId, accountId, refreshToken }) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      access_token: jwt({ sub: userId }),
      id_token: jwt({ sub: userId, email: "user@example.com" }),
      refresh_token: refreshToken
    }
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

test("switch preserves refreshed OAuth credentials for the next switch back", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-auth-switch-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));

  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir);

  const officialKey = "user-1::account-1";
  const thirdPartyKey = "manual::third-party";
  const staleAuth = oauthAuth({
    userId: "user-1",
    accountId: "account-1",
    refreshToken: "stale-refresh-token"
  });
  const refreshedAuth = oauthAuth({
    userId: "user-1",
    accountId: "account-1",
    refreshToken: "refreshed-token"
  });
  const thirdPartyAuth = { OPENAI_API_KEY: "third-party-key" };

  await writeJson(path.join(codexHome, "auth.json"), refreshedAuth);
  await fs.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"openai\"\n", "utf8");
  await writeJson(path.join(accountsDir, accountKeyToFilename(officialKey)), staleAuth);
  await fs.writeFile(
    path.join(accountsDir, accountKeyToConfigFilename(officialKey)),
    "model_provider = \"openai\"\n",
    "utf8"
  );
  await writeJson(path.join(accountsDir, accountKeyToFilename(thirdPartyKey)), thirdPartyAuth);
  await fs.writeFile(
    path.join(accountsDir, accountKeyToConfigFilename(thirdPartyKey)),
    "model_provider = \"third-party\"\n",
    "utf8"
  );
  await writeJson(path.join(accountsDir, "registry.json"), {
    schema_version: 3,
    active_account_key: officialKey,
    accounts: [
      {
        account_key: officialKey,
        email: "user@example.com",
        alias: "official",
        auth_mode: "chatgpt",
        provider: "openai"
      },
      {
        account_key: thirdPartyKey,
        email: null,
        alias: "third-party",
        auth_mode: "manual",
        provider: "third-party"
      }
    ]
  });

  await useAccount(codexHome, "third-party");

  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(accountsDir, accountKeyToFilename(officialKey)), "utf8")),
    refreshedAuth
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8")),
    thirdPartyAuth
  );

  await useAccount(codexHome, "official");

  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8")),
    refreshedAuth
  );
});

async function setupTwoAccounts(t, { liveConfig, officialConfig, thirdPartyConfig }) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-auth-config-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir);

  const officialKey = "user-1::account-1";
  const thirdPartyKey = "manual::third-party";
  const auth = oauthAuth({ userId: "user-1", accountId: "account-1", refreshToken: "token" });
  await writeJson(path.join(codexHome, "auth.json"), auth);
  await fs.writeFile(path.join(codexHome, "config.toml"), liveConfig, "utf8");
  await writeJson(path.join(accountsDir, accountKeyToFilename(officialKey)), auth);
  await fs.writeFile(path.join(accountsDir, accountKeyToConfigFilename(officialKey)), officialConfig, "utf8");
  await writeJson(path.join(accountsDir, accountKeyToFilename(thirdPartyKey)), { OPENAI_API_KEY: "key" });
  await fs.writeFile(path.join(accountsDir, accountKeyToConfigFilename(thirdPartyKey)), thirdPartyConfig, "utf8");
  await writeJson(path.join(accountsDir, "registry.json"), {
    schema_version: 3,
    active_account_key: officialKey,
    accounts: [
      { account_key: officialKey, email: "user@example.com", alias: "official", auth_mode: "chatgpt", provider: "openai" },
      { account_key: thirdPartyKey, email: null, alias: "third-party", auth_mode: "manual", provider: "third-party" }
    ]
  });
  return { codexHome, accountsDir, officialKey, thirdPartyKey };
}

test("switch keeps projects and MCP servers added after the snapshot was taken", async (t) => {
  const { codexHome } = await setupTwoAccounts(t, {
    liveConfig: "model = \"gpt-new\"\n\n[projects.\"/new\"]\ntrust_level = \"trusted\"\n\n[mcp_servers.tool]\ncommand = \"tool\"\n",
    officialConfig: "model = \"gpt-old\"\n",
    thirdPartyConfig: "model = \"other\"\nmodel_provider = \"third-party\"\n\n[model_providers.third-party]\nbase_url = \"https://example.invalid\"\n"
  });
  const configPath = path.join(codexHome, "config.toml");

  await useAccount(codexHome, "third-party");
  const thirdPartyLive = await fs.readFile(configPath, "utf8");
  assert.match(thirdPartyLive, /model_provider = "third-party"/);
  assert.match(thirdPartyLive, /\[model_providers\.third-party]/);
  assert.match(thirdPartyLive, /\[projects\."\/new"]/);
  assert.match(thirdPartyLive, /\[mcp_servers\.tool]/);

  await useAccount(codexHome, "official");
  const officialLive = await fs.readFile(configPath, "utf8");
  // The model chosen while the official account was active was saved on the
  // way out and comes back with it.
  assert.match(officialLive, /^model = "gpt-new"$/m);
  assert.doesNotMatch(officialLive, /model_provider|model_providers/);
  assert.match(officialLive, /\[projects\."\/new"]/);
  assert.match(officialLive, /\[mcp_servers\.tool]/);
});

test("switch does not save a hand-edited config into the active account's snapshot", async (t) => {
  const { codexHome, accountsDir, officialKey } = await setupTwoAccounts(t, {
    liveConfig: "model_provider = \"elsewhere\"\n",
    officialConfig: "model = \"gpt\"\n",
    thirdPartyConfig: "model_provider = \"third-party\"\n"
  });

  await useAccount(codexHome, "third-party");
  assert.equal(
    await fs.readFile(path.join(accountsDir, accountKeyToConfigFilename(officialKey)), "utf8"),
    "model = \"gpt\"\n"
  );
});

test("add with a third-party provider ignores ChatGPT tokens left in auth.json", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-auth-add-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await writeJson(path.join(codexHome, "auth.json"), oauthAuth({ userId: "user-1", accountId: "account-1", refreshToken: "t" }));
  await fs.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"third-party\"\n", "utf8");

  await assert.rejects(addAccount(codexHome, undefined), /Provide an alias/);
  const result = await addAccount(codexHome, "work");
  assert.equal(result.accountKey, "manual::work");

  const accountsDir = path.join(codexHome, "accounts");
  for (const name of [accountKeyToFilename("manual::work"), accountKeyToConfigFilename("manual::work"), "registry.json"]) {
    const { mode } = await fs.stat(path.join(accountsDir, name));
    assert.equal(mode & 0o777, 0o600, name);
  }
});

test("syncing the active account keeps a known email when the token has none", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-auth-sync-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await fs.mkdir(path.join(codexHome, "accounts"));
  await writeJson(path.join(codexHome, "auth.json"), {
    auth_mode: "chatgpt",
    tokens: { account_id: "account-1", access_token: jwt({ sub: "user-1" }) }
  });
  await writeJson(path.join(codexHome, "accounts", "registry.json"), {
    schema_version: 3,
    active_account_key: null,
    accounts: [{ account_key: "user-1::account-1", email: "user@example.com", alias: "" }]
  });

  assert.equal(await syncActiveAccountFromCurrentAuth(codexHome), true);
  const registry = JSON.parse(await fs.readFile(path.join(codexHome, "accounts", "registry.json"), "utf8"));
  assert.equal(registry.active_account_key, "user-1::account-1");
  assert.equal(registry.accounts[0].email, "user@example.com");
});

test("switch registers a login that has no snapshot before replacing it", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-auth-unregistered-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));

  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir);

  const targetKey = "user-1::account-1";
  const targetAuth = oauthAuth({ userId: "user-1", accountId: "account-1", refreshToken: "target-token" });
  const liveAuth = oauthAuth({ userId: "user-2", accountId: "account-2", refreshToken: "live-token" });
  await writeJson(path.join(accountsDir, accountKeyToFilename(targetKey)), targetAuth);
  await writeJson(path.join(codexHome, "auth.json"), liveAuth);
  await writeJson(path.join(accountsDir, "registry.json"), {
    schema_version: 3,
    active_account_key: targetKey,
    accounts: [{ account_key: targetKey, email: "target@example.com", alias: "target" }]
  });

  await useAccount(codexHome, "target");

  const liveSnapshot = await fs.readFile(
    path.join(accountsDir, accountKeyToFilename("user-2::account-2")),
    "utf8"
  );
  assert.equal(JSON.parse(liveSnapshot).tokens.refresh_token, "live-token");

  const registry = JSON.parse(await fs.readFile(path.join(accountsDir, "registry.json"), "utf8"));
  assert.deepEqual(
    registry.accounts.map((account) => account.account_key),
    [targetKey, "user-2::account-2"]
  );
  assert.equal(registry.active_account_key, targetKey);
});
