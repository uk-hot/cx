import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  accountKeyToConfigFilename,
  accountKeyToFilename,
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
