import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addAccount, syncActiveAccountFromCurrentAuth, useAccount } from "../src/accounts.js";
import { accountKeyToConfigFilename, accountKeyToFilename } from "../src/registry.js";

// One person signing in with Google and with a password gets two `sub`s, so two
// registry keys, but the same ChatGPT user id and account id in the tokens.

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function login({ sub, chatgptUserId = "user-same", accountId = "account-1", email = "me@example.com", refreshedAt, token }) {
  const auth = { chatgpt_user_id: chatgptUserId, chatgpt_account_id: accountId };
  return {
    auth_mode: "chatgpt",
    last_refresh: refreshedAt,
    tokens: {
      account_id: accountId,
      id_token: jwt({ sub, email, "https://api.openai.com/auth": auth }),
      access_token: jwt({ sub, "https://api.openai.com/auth": auth }),
      refresh_token: token
    }
  };
}

const GOOGLE = "google-oauth2|1";
const PASSWORD = "auth0|2";
const googleKey = `${GOOGLE}::account-1`;
const passwordKey = `${PASSWORD}::account-1`;

async function setup(t) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-duplicate-logins-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir);
  await fs.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"openai\"\n");
  const json = (file) => fs.readFile(file, "utf8").then(JSON.parse);
  return {
    codexHome,
    accountsDir,
    writeAuth: (value) => fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify(value)),
    writeSnapshot: (key, value) => fs.writeFile(path.join(accountsDir, accountKeyToFilename(key)), JSON.stringify(value)),
    writeRegistry: (value) => fs.writeFile(path.join(accountsDir, "registry.json"), JSON.stringify({ schema_version: 3, ...value })),
    writeOwners: (threads) => fs.writeFile(path.join(accountsDir, "threads.json"), JSON.stringify({ version: 1, threads })),
    readRegistry: () => json(path.join(accountsDir, "registry.json")),
    readOwners: () => json(path.join(accountsDir, "threads.json")),
    readSnapshot: (key) => json(path.join(accountsDir, accountKeyToFilename(key))),
    snapshotExists: (key) => fs.access(path.join(accountsDir, accountKeyToFilename(key))).then(() => true, () => false)
  };
}

const entry = (key, extra = {}) => ({ account_key: key, email: "me@example.com", alias: "", created_at: 100, last_used_at: 100, ...extra });

test("adding the same person signed in another way replaces the old sign-in", async (t) => {
  const ctx = await setup(t);
  await ctx.writeAuth(login({ sub: GOOGLE, refreshedAt: "2026-11-01T00:00:00Z", token: "dead" }));
  await addAccount(ctx.codexHome, "me");
  await ctx.writeOwners({ "thread-1": { account: googleKey, via: "activity", at: 1 } });

  await ctx.writeAuth(login({ sub: PASSWORD, refreshedAt: "2026-11-24T00:00:00Z", token: "fresh" }));
  const added = await addAccount(ctx.codexHome);

  assert.equal(added.accountKey, passwordKey);
  assert.equal(added.alias, "me");
  const registry = await ctx.readRegistry();
  assert.deepEqual(registry.accounts.map((account) => [account.account_key, account.alias]), [[passwordKey, "me"]]);
  assert.equal(registry.active_account_key, passwordKey);
  assert.equal((await ctx.readSnapshot(passwordKey)).tokens.refresh_token, "fresh");
  assert.equal(await ctx.snapshotExists(googleKey), false);
  assert.equal((await ctx.readOwners()).threads["thread-1"].account, passwordKey);
});

test("an explicit add wins even over newer tokens of the other sign-in", async (t) => {
  const ctx = await setup(t);
  await ctx.writeAuth(login({ sub: GOOGLE, refreshedAt: "2026-11-24T00:00:00Z", token: "google" }));
  await addAccount(ctx.codexHome);
  await ctx.writeAuth(login({ sub: PASSWORD, refreshedAt: "2026-11-01T00:00:00Z", token: "password" }));

  await addAccount(ctx.codexHome);

  assert.deepEqual((await ctx.readRegistry()).accounts.map((account) => account.account_key), [passwordKey]);
});

test("accounts already registered twice are folded into the one with the newest tokens", async (t) => {
  const ctx = await setup(t);
  await ctx.writeSnapshot(googleKey, login({ sub: GOOGLE, refreshedAt: "2026-11-24T00:00:00Z", token: "fresh" }));
  await ctx.writeSnapshot(passwordKey, login({ sub: PASSWORD, refreshedAt: "2026-11-14T00:00:00Z", token: "dead" }));
  await fs.writeFile(path.join(ctx.accountsDir, accountKeyToConfigFilename(passwordKey)), "model_provider = \"openai\"\n");
  await ctx.writeRegistry({
    active_account_key: passwordKey,
    active_account_activated_at_ms: 5,
    accounts: [
      entry(passwordKey, { alias: "work", created_at: 50, plan: "team", last_usage: { five_hour: 1 } }),
      entry(googleKey, { created_at: 200, last_used_at: 300 }),
      entry("auth0|other::account-1", { email: "teammate@example.com" })
    ]
  });
  await ctx.writeOwners({
    a: { account: passwordKey, via: "activity", at: 1 },
    b: { account: googleKey, via: "tag", at: 2 },
    c: { account: "auth0|other::account-1", via: "manual", at: 3 }
  });

  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), true);

  const registry = await ctx.readRegistry();
  assert.deepEqual(registry.accounts.map((account) => account.account_key), [googleKey, "auth0|other::account-1"]);
  const kept = registry.accounts[0];
  assert.equal(kept.alias, "work");
  assert.equal(kept.created_at, 50);
  assert.equal(kept.last_used_at, 300);
  assert.equal(kept.plan, "team");
  assert.deepEqual(kept.last_usage, { five_hour: 1 });
  assert.equal(registry.active_account_key, googleKey);
  assert.equal(registry.active_account_activated_at_ms, 5);
  const owners = (await ctx.readOwners()).threads;
  assert.deepEqual(Object.fromEntries(Object.entries(owners).map(([id, owner]) => [id, owner.account])),
    { a: googleKey, b: googleKey, c: "auth0|other::account-1" });
  assert.equal(await ctx.snapshotExists(passwordKey), false);
  await assert.rejects(fs.access(path.join(ctx.accountsDir, accountKeyToConfigFilename(passwordKey))), /ENOENT/);

  // Nothing left to fold.
  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), false);
});

test("the live login's refreshed tokens count when choosing which sign-in to keep", async (t) => {
  const ctx = await setup(t);
  await ctx.writeSnapshot(googleKey, login({ sub: GOOGLE, refreshedAt: "2026-11-10T00:00:00Z", token: "google" }));
  await ctx.writeSnapshot(passwordKey, login({ sub: PASSWORD, refreshedAt: "2026-11-01T00:00:00Z", token: "old" }));
  await ctx.writeAuth(login({ sub: PASSWORD, refreshedAt: "2026-11-20T00:00:00Z", token: "refreshed" }));
  await ctx.writeRegistry({ active_account_key: passwordKey, accounts: [entry(googleKey), entry(passwordKey)] });

  await syncActiveAccountFromCurrentAuth(ctx.codexHome);

  const registry = await ctx.readRegistry();
  assert.deepEqual(registry.accounts.map((account) => account.account_key), [passwordKey]);
  assert.equal(registry.active_account_key, passwordKey);
});

test("teammates in one workspace and one person in two workspaces stay separate", async (t) => {
  const ctx = await setup(t);
  const teammateKey = "auth0|3::account-1";
  const otherWorkspaceKey = "auth0|2::account-2";
  await ctx.writeSnapshot(passwordKey, login({ sub: PASSWORD, refreshedAt: "2026-11-01T00:00:00Z", token: "a" }));
  await ctx.writeSnapshot(teammateKey, login({ sub: "auth0|3", chatgptUserId: "user-teammate", refreshedAt: "2026-11-01T00:00:00Z", token: "b" }));
  await ctx.writeSnapshot(otherWorkspaceKey, login({ sub: PASSWORD, accountId: "account-2", refreshedAt: "2026-11-01T00:00:00Z", token: "c" }));
  await ctx.writeRegistry({ active_account_key: null, accounts: [entry(passwordKey), entry(teammateKey), entry(otherWorkspaceKey)] });

  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), false);
  assert.equal((await ctx.readRegistry()).accounts.length, 3);
});

test("an unreadable thread owner file does not stop the sync, and the fold waits", async (t) => {
  const ctx = await setup(t);
  await ctx.writeSnapshot(googleKey, login({ sub: GOOGLE, refreshedAt: "2026-11-24T00:00:00Z", token: "fresh" }));
  await ctx.writeSnapshot(passwordKey, login({ sub: PASSWORD, refreshedAt: "2026-11-14T00:00:00Z", token: "dead" }));
  await ctx.writeRegistry({ active_account_key: null, accounts: [entry(passwordKey), entry(googleKey)] });
  await fs.writeFile(path.join(ctx.accountsDir, "threads.json"), "{not json");

  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), false);
  assert.equal((await ctx.readRegistry()).accounts.length, 2);
});

test("switching away from a stale sign-in does not register it again next to the newer one", async (t) => {
  const ctx = await setup(t);
  const otherKey = "auth0|9::account-9";
  await ctx.writeSnapshot(googleKey, login({ sub: GOOGLE, refreshedAt: "2026-11-24T00:00:00Z", token: "fresh" }));
  await ctx.writeSnapshot(otherKey, login({ sub: "auth0|9", chatgptUserId: "user-9", accountId: "account-9", email: "x@example.com", refreshedAt: "2026-11-24T00:00:00Z", token: "x" }));
  await ctx.writeAuth(login({ sub: PASSWORD, refreshedAt: "2026-11-14T00:00:00Z", token: "stale" }));
  await ctx.writeRegistry({ active_account_key: googleKey, accounts: [entry(googleKey), entry(otherKey, { email: "x@example.com" })] });

  await useAccount(ctx.codexHome, "x@example.com");

  const registry = await ctx.readRegistry();
  assert.deepEqual(registry.accounts.map((account) => account.account_key), [googleKey, otherKey]);
  assert.equal(registry.active_account_key, otherKey);
  assert.equal(await ctx.snapshotExists(passwordKey), false);
});
