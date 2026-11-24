import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncActiveAccountFromCurrentAuth, useAccount } from "../src/accounts.js";
import { accountKeyToConfigFilename, accountKeyToFilename } from "../src/registry.js";
import { runSwitch } from "../src/service.js";
import { deadSavedLogin } from "../src/usage-service.js";

// Signing in again without cx add: cx switch to the signed-out account leaves
// Codex signed out, Codex signs in, and cx saves that login.

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const NOW = Date.parse("2026-11-24T12:00:00Z");

function login({ sub = "auth0|me", chatgptUserId = "user-me", accountId = "account-me", email = "me@example.com", refreshedAt = "2026-11-14T00:00:00Z", expiresAt = NOW / 1000 + 3600, token = "t" } = {}) {
  const auth = { chatgpt_user_id: chatgptUserId, chatgpt_account_id: accountId };
  return JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: refreshedAt,
    tokens: {
      account_id: accountId,
      id_token: jwt({ sub, email, "https://api.openai.com/auth": auth }),
      access_token: jwt({ sub, exp: expiresAt, "https://api.openai.com/auth": auth }),
      refresh_token: token
    }
  });
}

const meKey = "auth0|me::account-me";
const otherKey = "auth0|other::account-other";
const otherLogin = login({ sub: "auth0|other", chatgptUserId: "user-other", accountId: "account-other", email: "other@example.com", token: "other" });

async function setup(t) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-sign-in-again-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir);
  const authPath = path.join(codexHome, "auth.json");
  await fs.writeFile(path.join(codexHome, "config.toml"), "model_provider = \"openai\"\n");
  for (const key of [meKey, otherKey]) {
    await fs.writeFile(path.join(accountsDir, accountKeyToConfigFilename(key)), "model_provider = \"openai\"\n");
  }
  await fs.writeFile(path.join(accountsDir, accountKeyToFilename(meKey)), login({ token: "dead" }));
  await fs.writeFile(path.join(accountsDir, accountKeyToFilename(otherKey)), otherLogin);
  await fs.writeFile(authPath, otherLogin);
  const account = (key, email) => ({ account_key: key, email, alias: "", auth_mode: "chatgpt", provider: "openai", created_at: 1, last_used_at: 1 });
  await fs.writeFile(path.join(accountsDir, "registry.json"), JSON.stringify({
    schema_version: 3,
    active_account_key: otherKey,
    accounts: [account(meKey, "me@example.com"), account(otherKey, "other@example.com")]
  }));
  return {
    codexHome,
    authPath,
    readRegistry: async () => JSON.parse(await fs.readFile(path.join(accountsDir, "registry.json"), "utf8")),
    readSnapshot: (key) => fs.readFile(path.join(accountsDir, accountKeyToFilename(key)), "utf8")
  };
}

test("switching to a signed-out account leaves Codex signed out and keeps the snapshot", async (t) => {
  const ctx = await setup(t);

  await useAccount(ctx.codexHome, "me@example.com", { signIn: true });

  await assert.rejects(fs.access(ctx.authPath), /ENOENT/);
  assert.equal(JSON.parse(await ctx.readSnapshot(meKey)).tokens.refresh_token, "dead");
  assert.equal((await ctx.readRegistry()).active_account_key, meKey);
  // The outgoing account's tokens were saved as usual.
  assert.equal(await ctx.readSnapshot(otherKey), otherLogin);
});

test("runSwitch passes the sign-in request on", async (t) => {
  const ctx = await setup(t);
  await runSwitch({ codexHome: ctx.codexHome, identifier: "me@example.com", signIn: true });
  await assert.rejects(fs.access(ctx.authPath), /ENOENT/);
});

test("the login Codex signs in to afterwards is saved over the dead one", async (t) => {
  const ctx = await setup(t);
  await useAccount(ctx.codexHome, "me@example.com", { signIn: true });
  const fresh = login({ refreshedAt: "2026-11-24T11:00:00Z", token: "fresh" });
  await fs.writeFile(ctx.authPath, fresh);

  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), true);
  assert.equal(await ctx.readSnapshot(meKey), fresh);
  // Nothing new the next time.
  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), false);
});

test("signing in another way (Google instead of a password) replaces the dead sign-in", async (t) => {
  const ctx = await setup(t);
  await useAccount(ctx.codexHome, "me@example.com", { signIn: true });
  const google = login({ sub: "google-oauth2|me", refreshedAt: "2026-11-24T11:00:00Z", token: "google" });
  await fs.writeFile(ctx.authPath, google);

  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), true);
  const registry = await ctx.readRegistry();
  assert.deepEqual(registry.accounts.map((account) => account.account_key).sort(), ["google-oauth2|me::account-me", otherKey].sort());
  assert.equal(registry.active_account_key, "google-oauth2|me::account-me");
  assert.equal(await ctx.readSnapshot("google-oauth2|me::account-me"), google);
});

test("a login of an account cx doesn't know is registered", async (t) => {
  const ctx = await setup(t);
  await useAccount(ctx.codexHome, "me@example.com", { signIn: true });
  await fs.writeFile(ctx.authPath, login({ sub: "auth0|new", chatgptUserId: "user-new", accountId: "account-new", email: "new@example.com" }));

  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), true);
  const registry = await ctx.readRegistry();
  assert.equal(registry.accounts.length, 3);
  assert.equal(registry.active_account_key, "auth0|new::account-new");
});

test("tokens Codex refreshed reach the snapshot, older ones never do", async (t) => {
  const ctx = await setup(t);
  const refreshed = JSON.stringify({ ...JSON.parse(otherLogin), last_refresh: "2026-11-24T11:00:00Z" });
  await fs.writeFile(ctx.authPath, refreshed);
  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), true);
  assert.equal(await ctx.readSnapshot(otherKey), refreshed);

  await fs.writeFile(ctx.authPath, otherLogin);
  assert.equal(await syncActiveAccountFromCurrentAuth(ctx.codexHome), false);
  assert.equal(await ctx.readSnapshot(otherKey), refreshed);
});

test("only a token rejected before it expires, or a missing login, counts as dead", async (t) => {
  const ctx = await setup(t);
  const dir = path.join(ctx.codexHome, "accounts");
  let requests = 0;
  const respond = (status) => async () => {
    requests += 1;
    return { status, ok: status === 200, json: async () => ({ plan_type: "team", rate_limit: null }) };
  };

  assert.equal(await deadSavedLogin(ctx.codexHome, meKey, { fetchFn: respond(401), now: NOW }), "signed out");
  assert.equal(await deadSavedLogin(ctx.codexHome, meKey, { fetchFn: respond(200), now: NOW }), null);
  assert.equal(await deadSavedLogin(ctx.codexHome, meKey, { fetchFn: respond(500), now: NOW }), null);
  assert.equal(requests, 3);

  await fs.writeFile(path.join(dir, accountKeyToFilename(meKey)), login({ expiresAt: NOW / 1000 - 60 }));
  assert.equal(await deadSavedLogin(ctx.codexHome, meKey, { fetchFn: respond(401), now: NOW }), null);
  assert.equal(requests, 3, "an expired token is not sent");

  await fs.rm(path.join(dir, accountKeyToFilename(meKey)));
  assert.equal(await deadSavedLogin(ctx.codexHome, meKey, { fetchFn: respond(401), now: NOW }), "no saved login");
  assert.equal(await deadSavedLogin(ctx.codexHome, "manual::nobody", { fetchFn: respond(401), now: NOW }), null);
});
