import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { accountKeyToFilename, readRegistry, writeRegistry } from "../src/auth-service.js";
import {
  formatUsage,
  loadUsageDisplayState,
  refreshChatgptUsageFromApi,
  renderAccountsTable
} from "../src/usage-service.js";

async function makeTempCodexHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-usage-test-"));
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  return { root, codexHome };
}

async function writeActiveRegistry(codexHome, overrides = {}) {
  const account = {
    account_key: "user-1::acc-1",
    chatgpt_account_id: "acc-1",
    chatgpt_user_id: "user-1",
    email: "openai@example.com",
    alias: "main",
    account_name: null,
    plan: null,
    auth_mode: "chatgpt",
    provider: "openai",
    created_at: 1,
    last_used_at: 1,
    last_usage: null,
    last_usage_at: null,
    last_local_rollout: null,
    ...overrides.account
  };

  const accounts = [account, ...(overrides.extraAccounts ?? [])];

  await writeRegistry(codexHome, {
    schema_version: 3,
    active_account_key: account.account_key,
    active_account_activated_at_ms: overrides.active_account_activated_at_ms ?? 0,
    auto_switch: { enabled: false, threshold_5h_percent: 10, threshold_weekly_percent: 5 },
    api: { usage: false, account: false },
    accounts
  });

  const accountsDir = path.join(codexHome, "accounts");
  await fs.mkdir(accountsDir, { recursive: true });
  for (const item of accounts) {
    if (item.auth_mode !== "chatgpt") {
      continue;
    }
    await fs.writeFile(
      path.join(accountsDir, accountKeyToFilename(item.account_key)),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: `token-for-${item.chatgpt_account_id}`,
          account_id: item.chatgpt_account_id
        }
      }, null, 2),
      "utf8"
    );
  }
}

function makeApiFetchResponse(payload, status = 200) {
  return {
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test("renderAccountsTable shows a formatted table with grouped rows and usage columns", () => {
  const output = renderAccountsTable([
    {
      account_key: "user-1::acc-1",
      email: "openai@example.com",
      alias: "main",
      account_name: null,
      plan: null,
      provider: "openai",
      last_usage: {
        primary: { used_percent: 25.0, window_minutes: 300, resets_at: 9999999999 },
        secondary: { used_percent: 10.0, window_minutes: 10080, resets_at: 9999999999 },
        plan_type: "pro"
      },
      last_usage_at: Math.floor(Date.now() / 1000)
    },
    {
      account_key: "manual::owl",
      email: null,
      alias: "owl",
      account_name: null,
      plan: null,
      provider: "owl",
      last_usage: null,
      last_usage_at: null
    }
  ], "user-1::acc-1");

  assert.match(output, /ACCOUNT\s+PROVIDER\s+PLAN\s+5H USAGE\s+WEEKLY USAGE\s+LAST ACTIVITY/);
  assert.match(output, /\* openai@example\.com\s+openai\s+pro\s+/);
  assert.match(output, /\s+owl\s+owl\s+-\s+-\s+-\s+-/);
});

test("formatUsage renders the active account table and explains unsupported accounts", () => {
  const output = formatUsage({
    accounts: [{
      account_key: "user-1::acc-1",
      email: "openai@example.com",
      alias: "main",
      account_name: null,
      plan: null,
      provider: "openai",
      last_usage: {
        primary: { used_percent: 25.0, window_minutes: 300, resets_at: 9999999999 },
        secondary: { used_percent: 10.0, window_minutes: 10080, resets_at: 9999999999 },
        plan_type: "pro"
      },
      last_usage_at: Math.floor(Date.now() / 1000)
    }],
    visibleActiveAccountKey: null,
    activeAccount: {
      account_key: "manual::owl",
      email: null,
      alias: "owl",
      account_name: null,
      plan: null,
      provider: "owl",
      last_usage: null,
      last_usage_at: null
    },
    currentAccount: {
      account_key: "manual::owl",
      email: null,
      alias: "owl",
      account_name: null,
      plan: null,
      provider: "owl",
      last_usage: null,
      last_usage_at: null
    },
    rateLimits: null,
    usageSupported: false
  });

  assert.match(output, /ACCOUNT\s+PROVIDER\s+PLAN\s+5H USAGE\s+WEEKLY USAGE\s+LAST ACTIVITY/);
  assert.match(output, /openai@example\.com\s+openai\s+pro\s+/);
  assert.match(output, /Current active account is not ChatGPT\/OAuth\. Showing saved usage for ChatGPT\/OAuth accounts\./);
});

test("loadUsageDisplayState shows all ChatGPT accounts even when the active account is third-party", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeActiveRegistry(codexHome, {
    account: {
      account_key: "manual::owl",
      chatgpt_account_id: null,
      chatgpt_user_id: null,
      email: null,
      alias: "owl",
      auth_mode: "manual",
      provider: "owl"
    },
    extraAccounts: [
      {
        account_key: "user-1::acc-1",
        chatgpt_account_id: "acc-1",
        chatgpt_user_id: "user-1",
        email: "openai@example.com",
        alias: "main",
        account_name: null,
        plan: null,
        auth_mode: "chatgpt",
        provider: "openai",
        created_at: 1,
        last_used_at: 1,
        last_usage: {
          primary: { used_percent: 25.0, window_minutes: 300, resets_at: 9999999999 },
          secondary: { used_percent: 10.0, window_minutes: 10080, resets_at: 9999999999 },
          plan_type: "pro"
        },
        last_usage_at: 123,
        last_local_rollout: null
      }
    ]
  });

  const state = await loadUsageDisplayState(codexHome, {
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  assert.equal(state.activeAccount.account_key, "manual::owl");
  assert.equal(state.visibleActiveAccountKey, null);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].account_key, "user-1::acc-1");
});

test("refreshChatgptUsageFromApi updates saved ChatGPT accounts from wham usage", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeActiveRegistry(codexHome, {
    account: {
      account_key: "manual::owl",
      chatgpt_account_id: null,
      chatgpt_user_id: null,
      email: null,
      alias: "owl",
      auth_mode: "manual",
      provider: "owl"
    },
    extraAccounts: [
      {
        account_key: "user-1::acc-1",
        chatgpt_account_id: "acc-1",
        chatgpt_user_id: "user-1",
        email: "openai@example.com",
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
      },
      {
        account_key: "user-2::acc-2",
        chatgpt_account_id: "acc-2",
        chatgpt_user_id: "user-2",
        email: "second@example.com",
        alias: "",
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

  const calls = [];
  const result = await refreshChatgptUsageFromApi(codexHome, {
    fetchImpl: async (_url, options) => {
      calls.push(options.headers["ChatGPT-Account-Id"]);
      if (options.headers["ChatGPT-Account-Id"] === "acc-1") {
        return makeApiFetchResponse({
          plan_type: "team",
          rate_limit: {
            primary_window: { used_percent: 33, limit_window_seconds: 18000, reset_at: 9999999999 },
            secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 9999999999 }
          }
        });
      }
      return makeApiFetchResponse({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 9999999999 },
          secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: 9999999999 }
        }
      });
    }
  });

  assert.equal(result.updated, true);
  assert.deepEqual(calls.sort(), ["acc-1", "acc-2"]);

  const registry = await readRegistry(codexHome);
  const first = registry.accounts.find((account) => account.account_key === "user-1::acc-1");
  const second = registry.accounts.find((account) => account.account_key === "user-2::acc-2");
  const manual = registry.accounts.find((account) => account.account_key === "manual::owl");
  assert.equal(first.last_usage.primary.used_percent, 33);
  assert.equal(first.last_usage.plan_type, "team");
  assert.equal(second.last_usage.primary.used_percent, 20);
  assert.equal(second.last_usage.plan_type, "pro");
  assert.equal(manual.last_usage, null);
});

test("loadUsageDisplayState uses API-refreshed usage for visible ChatGPT accounts", async () => {
  const { codexHome } = await makeTempCodexHome();
  await writeActiveRegistry(codexHome);

  const state = await loadUsageDisplayState(codexHome, {
    fetchImpl: async () => makeApiFetchResponse({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 14, limit_window_seconds: 18000, reset_at: 9999999999 },
        secondary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 9999999999 }
      }
    })
  });

  assert.equal(state.visibleActiveAccountKey, "user-1::acc-1");
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].last_usage.primary.used_percent, 14);
  assert.equal(state.accounts[0].last_usage.plan_type, "team");
});
