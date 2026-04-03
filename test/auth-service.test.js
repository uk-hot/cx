import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  accountKeyToFilename,
  accountKeyToConfigFilename,
  findAccountsByIdentifier,
  filenameToAccountKey,
  getCurrentAccount,
  listAccounts,
  parseAuthFile,
  readRegistry,
  removeAccount,
  saveAccount,
  syncActiveAccountFromCurrentAuth,
  useAccount,
  writeRegistry
} from "../src/auth-service.js";

async function makeTempCodexHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auth-test-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  return { root, codexHome };
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

async function writeConfigToml(codexHome, content) {
  await fs.writeFile(path.join(codexHome, "config.toml"), content, "utf8");
}

const OPENAI_CONFIG = `model_provider = "openai"\nmodel = "gpt-5.4"\n`;
const THIRDPARTY_CONFIG = `model_provider = "my-provider"\n\n[model_providers.my-provider]\napi_key = "sk-test"\nbase_url = "https://api.example.com/v1"\n`;

// --- parseAuthFile ---

test("parseAuthFile extracts account key and email from auth data", () => {
  const authData = makeFakeAuthJson({ userId: "user-abc123", accountId: "acc-001", email: "test@example.com" });
  const result = parseAuthFile(authData);
  assert.equal(result.accountKey, "user-abc123::acc-001");
  assert.equal(result.email, "test@example.com");
  assert.equal(result.authMode, "chatgpt");
});

test("parseAuthFile returns null for missing tokens", () => {
  assert.equal(parseAuthFile({}), null);
  assert.equal(parseAuthFile({ tokens: {} }), null);
  assert.equal(parseAuthFile({ tokens: { account_id: "a" } }), null);
});

// --- filename helpers ---

test("accountKeyToFilename and filenameToAccountKey round-trip", () => {
  const key = "user-abc123::acc-001";
  const filename = accountKeyToFilename(key);
  assert.ok(filename.endsWith(".auth.json"));
  assert.equal(filenameToAccountKey(filename), key);
});

test("filenameToAccountKey returns null for non-auth filenames", () => {
  assert.equal(filenameToAccountKey("registry.json"), null);
});

// --- registry ---

test("readRegistry returns empty skeleton when no file exists", async () => {
  const { codexHome } = await makeTempCodexHome();
  const registry = await readRegistry(codexHome);
  assert.equal(registry.schema_version, 3);
  assert.deepEqual(registry.accounts, []);
});

test("writeRegistry and readRegistry round-trip", async () => {
  const { codexHome } = await makeTempCodexHome();
  const registry = { schema_version: 3, active_account_key: "x::1", accounts: [{ account_key: "x::1", email: "x@test.com" }] };
  await writeRegistry(codexHome, registry);
  const loaded = await readRegistry(codexHome);
  assert.equal(loaded.accounts[0].email, "x@test.com");
});

// --- saveAccount: OpenAI OAuth ---

test("saveAccount snapshots auth.json + config.toml for OpenAI account", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "alice@test.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);

  const result = await saveAccount(codexHome, "personal");
  assert.equal(result.email, "alice@test.com");
  assert.equal(result.provider, "openai");
  assert.equal(result.alias, "personal");

  const registry = await readRegistry(codexHome);
  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.accounts[0].provider, "openai");

  // verify both snapshot files exist
  const accountsDir = path.join(codexHome, "accounts");
  const authSnapshot = path.join(accountsDir, accountKeyToFilename("user-1::acc-1"));
  const configSnapshot = path.join(accountsDir, accountKeyToConfigFilename("user-1::acc-1"));
  await fs.access(authSnapshot);
  await fs.access(configSnapshot);
});

// --- saveAccount: third-party provider ---

test("saveAccount works with third-party provider (no OpenAI auth)", async () => {
  const { codexHome } = await makeTempCodexHome();
  // No auth.json — only config.toml
  await writeConfigToml(codexHome, THIRDPARTY_CONFIG);

  const result = await saveAccount(codexHome, "my-provider");
  assert.equal(result.accountKey, "manual::my-provider");
  assert.equal(result.provider, "my-provider");
  assert.equal(result.email, null);

  const registry = await readRegistry(codexHome);
  assert.equal(registry.accounts[0].auth_mode, "manual");
  assert.equal(registry.accounts[0].provider, "my-provider");

  // config snapshot exists, auth snapshot does not
  const accountsDir = path.join(codexHome, "accounts");
  const configSnapshot = path.join(accountsDir, accountKeyToConfigFilename("manual::my-provider"));
  await fs.access(configSnapshot);
});

test("saveAccount with third-party provider requires alias", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeConfigToml(codexHome, THIRDPARTY_CONFIG);
  await assert.rejects(() => saveAccount(codexHome), /Provide an alias/);
});

test("saveAccount throws when neither auth.json nor config.toml exists", async () => {
  const { codexHome } = await makeTempCodexHome();
  await assert.rejects(() => saveAccount(codexHome, "empty"), /Nothing to save/);
});

// --- saveAccount: dedup ---

test("saveAccount updates existing account instead of duplicating", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "a@test.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "v1");
  await saveAccount(codexHome, "v2");
  const registry = await readRegistry(codexHome);
  assert.equal(registry.accounts.length, 1);
  assert.equal(registry.accounts[0].alias, "v2");
});

test("saveAccount does not replace an existing active account", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeRegistry(codexHome, {
    schema_version: 3,
    active_account_key: "manual::existing",
    active_account_activated_at_ms: 1,
    auto_switch: { enabled: false, threshold_5h_percent: 10, threshold_weekly_percent: 5 },
    api: { usage: false, account: false },
    accounts: [{
      account_key: "manual::existing",
      chatgpt_account_id: null,
      chatgpt_user_id: null,
      email: null,
      alias: "existing",
      account_name: null,
      plan: null,
      auth_mode: "manual",
      provider: "owl",
      created_at: 1,
      last_used_at: 1,
      last_usage: null,
      last_usage_at: null,
      last_local_rollout: null
    }]
  });

  await writeConfigToml(codexHome, THIRDPARTY_CONFIG);
  await saveAccount(codexHome, "my-provider");

  const registry = await readRegistry(codexHome);
  assert.equal(registry.active_account_key, "manual::existing");
});

// --- useAccount ---

test("useAccount restores both auth.json and config.toml", async () => {
  const { codexHome } = await makeTempCodexHome();

  // Save OpenAI profile
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "one@test.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "openai-profile");

  // Save third-party profile
  await writeConfigToml(codexHome, THIRDPARTY_CONFIG);
  await fs.rm(path.join(codexHome, "auth.json"), { force: true });
  await saveAccount(codexHome, "my-provider");

  // Switch to openai-profile
  const result = await useAccount(codexHome, "openai-profile");
  assert.equal(result.email, "one@test.com");

  // Verify auth.json was restored
  const authText = await fs.readFile(path.join(codexHome, "auth.json"), "utf8");
  const authData = JSON.parse(authText);
  assert.equal(authData.tokens.account_id, "acc-1");

  // Verify config.toml was restored
  const configText = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configText, /model_provider = "openai"/);
});

test("useAccount restores config-only profile and removes stale auth.json", async () => {
  const { codexHome } = await makeTempCodexHome();

  // Save third-party profile (no auth.json)
  await writeConfigToml(codexHome, THIRDPARTY_CONFIG);
  await saveAccount(codexHome, "my-provider");

  // Simulate: after switching away, auth.json exists from an OpenAI profile
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "old@test.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);

  // Switch to third-party — auth.json should be removed
  const result = await useAccount(codexHome, "my-provider");
  assert.equal(result.provider, "my-provider");

  const configText = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configText, /model_provider = "my-provider"/);

  // auth.json must not exist
  await assert.rejects(() => fs.access(path.join(codexHome, "auth.json")));
});

test("useAccount matches by exact email case-insensitively", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "alice@example.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome);
  const result = await useAccount(codexHome, "ALICE@EXAMPLE.COM");
  assert.equal(result.email, "alice@example.com");
});

test("findAccountsByIdentifier returns unique fuzzy matches after exact matching fails", () => {
  const matches = findAccountsByIdentifier([
    { account_key: "user-1::acc-1", email: "alice@example.com", alias: "alice-main" },
    { account_key: "user-2::acc-2", email: "bob@example.com", alias: "bob-main" }
  ], "ali");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].email, "alice@example.com");
});

test("useAccount throws when fuzzy matching is ambiguous", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "alice@example.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "alice-main");

  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-2", accountId: "acc-2", email: "alex@example.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "alex-main");

  await assert.rejects(() => useAccount(codexHome, "al"), /Multiple saved accounts match/);
});

test("useAccount throws for unknown identifier", async () => {
  const { codexHome } = await makeTempCodexHome();
  await assert.rejects(() => useAccount(codexHome, "nobody"), /No saved account matches/);
});

// --- getCurrentAccount ---

test("getCurrentAccount returns active account with provider", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "a@test.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "main");
  const current = await getCurrentAccount(codexHome);
  assert.equal(current.email, "a@test.com");
  assert.equal(current.provider, "openai");
});

test("getCurrentAccount returns null when no active account", async () => {
  const { codexHome } = await makeTempCodexHome();
  assert.equal(await getCurrentAccount(codexHome), null);
});

test("syncActiveAccountFromCurrentAuth aligns registry active account with auth.json", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeRegistry(codexHome, {
    schema_version: 3,
    active_account_key: "manual::old",
    active_account_activated_at_ms: 1,
    auto_switch: { enabled: false, threshold_5h_percent: 10, threshold_weekly_percent: 5 },
    api: { usage: false, account: false },
    accounts: [
      {
        account_key: "manual::old",
        chatgpt_account_id: null,
        chatgpt_user_id: null,
        email: null,
        alias: "old",
        account_name: null,
        plan: null,
        auth_mode: "manual",
        provider: "owl",
        created_at: 1,
        last_used_at: 1,
        last_usage: null,
        last_usage_at: null,
        last_local_rollout: null
      },
      {
        account_key: "user-1::acc-1",
        chatgpt_account_id: "acc-1",
        chatgpt_user_id: "user-1",
        email: "old@test.com",
        alias: "main",
        account_name: null,
        plan: null,
        auth_mode: "chatgpt",
        provider: "openai",
        created_at: 1,
        last_used_at: 1,
        last_usage: null,
        last_usage_at: null,
        last_local_rollout: null
      }
    ]
  });
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "new@test.com" }));

  const changed = await syncActiveAccountFromCurrentAuth(codexHome);
  assert.equal(changed, true);

  const registry = await readRegistry(codexHome);
  assert.equal(registry.active_account_key, "user-1::acc-1");
  assert.equal(registry.accounts[1].email, "new@test.com");
});

// --- removeAccount ---

test("removeAccount deletes both auth and config snapshots", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "r@test.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "doomed");

  await removeAccount(codexHome, "doomed");

  const registry = await readRegistry(codexHome);
  assert.equal(registry.accounts.length, 0);
  assert.equal(registry.active_account_key, null);

  const accountsDir = path.join(codexHome, "accounts");
  const authSnapshot = path.join(accountsDir, accountKeyToFilename("user-1::acc-1"));
  const configSnapshot = path.join(accountsDir, accountKeyToConfigFilename("user-1::acc-1"));
  await assert.rejects(() => fs.access(authSnapshot));
  await assert.rejects(() => fs.access(configSnapshot));
});

test("removeAccount throws for unknown identifier", async () => {
  const { codexHome } = await makeTempCodexHome();
  await assert.rejects(() => removeAccount(codexHome, "nobody"), /No saved account matches/);
});

test("removeAccount throws when fuzzy matching is ambiguous", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "alice@example.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "alice-main");

  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-2", accountId: "acc-2", email: "alex@example.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "alex-main");

  await assert.rejects(() => removeAccount(codexHome, "al"), /Multiple saved accounts match/);
});

// --- registry compatibility ---

test("registry preserves extra fields from @loongphy/codex-auth", async () => {
  const { codexHome } = await makeTempCodexHome();
  const loongphyRegistry = {
    schema_version: 3,
    active_account_key: "user-x::acc-x",
    auto_switch: { enabled: true, threshold_5h_percent: 12, threshold_weekly_percent: 8 },
    api: { usage: true, account: true },
    accounts: [{
      account_key: "user-x::acc-x",
      email: "x@test.com",
      alias: "",
      plan: "team",
      auth_mode: "chatgpt",
      last_usage: { primary: { used_percent: 5, window_minutes: 300 } }
    }]
  };
  await writeRegistry(codexHome, loongphyRegistry);
  const loaded = await readRegistry(codexHome);
  assert.equal(loaded.auto_switch.enabled, true);
  assert.equal(loaded.api.usage, true);
  assert.equal(loaded.accounts[0].last_usage.primary.used_percent, 5);
});

// --- full round-trip: OpenAI <-> third-party ---

test("full round-trip: save OpenAI, save third-party, switch between them", async () => {
  const { codexHome } = await makeTempCodexHome();

  // Save OpenAI profile
  await writeAuthJson(codexHome, makeFakeAuthJson({ userId: "user-1", accountId: "acc-1", email: "openai@test.com" }));
  await writeConfigToml(codexHome, OPENAI_CONFIG);
  await saveAccount(codexHome, "openai");

  // Save third-party profile
  await fs.rm(path.join(codexHome, "auth.json"), { force: true });
  await writeConfigToml(codexHome, THIRDPARTY_CONFIG);
  await saveAccount(codexHome, "my-provider");

  // Verify list
  const accounts = await listAccounts(codexHome);
  assert.equal(accounts.length, 2);
  const providers = accounts.map((a) => a.provider).sort();
  assert.deepEqual(providers, ["my-provider", "openai"]);

  // Switch to OpenAI
  await useAccount(codexHome, "openai");
  let configText = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configText, /model_provider = "openai"/);
  let authExists = true;
  try { await fs.access(path.join(codexHome, "auth.json")); } catch { authExists = false; }
  assert.ok(authExists, "auth.json should exist after switching to OpenAI");

  // Switch to third-party
  await useAccount(codexHome, "my-provider");
  configText = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(configText, /model_provider = "my-provider"/);
  assert.match(configText, /api_key = "sk-test"/);
});
