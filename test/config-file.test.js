import assert from "node:assert/strict";
import test from "node:test";

import { mergeAccountConfigText, readCurrentProviderFromConfigText } from "../src/config-file.js";

test("reads the root provider in the TOML forms Codex accepts", () => {
  const cases = [
    ["model_provider = \"any\"\n", "any"],
    ["model_provider=\"any\"\n", "any"],
    ["model_provider = 'any'\n", "any"],
    ["model_provider = \"any\" # main account\n", "any"],
    ["\"model_provider\" = \"any\"\n", "any"]
  ];
  for (const [text, provider] of cases) {
    assert.deepEqual(readCurrentProviderFromConfigText(text), { provider, implicit: false }, text);
  }
});

test("falls back to the implicit default and ignores keys inside tables", () => {
  assert.deepEqual(
    readCurrentProviderFromConfigText("model = \"x\"\n[model_providers.any]\nmodel_provider = \"nope\"\n"),
    { provider: "openai", implicit: true }
  );
});

test("an active profile's provider overrides the root provider", () => {
  const text = [
    "model_provider = \"root\"",
    "profile = \"work\"",
    "[profiles.work]",
    "model_provider = \"work-provider\"",
    "[profiles.home]",
    "model_provider = \"home-provider\"",
    ""
  ].join("\n");
  assert.deepEqual(readCurrentProviderFromConfigText(text), { provider: "work-provider", implicit: false });
});

test("brackets inside multi-line strings and arrays are not table headers", () => {
  const text = [
    "developer_instructions = \"\"\"",
    "[not a table]",
    "\"\"\"",
    "notify = [",
    "  [\"a\"],",
    "]",
    "model_provider = \"any\"",
    ""
  ].join("\n");
  assert.equal(readCurrentProviderFromConfigText(text).provider, "any");
});

test("merge keeps shared settings from the live config and account settings from the snapshot", () => {
  const live = [
    "model = \"live-model\"",
    "approval_policy = \"never\"",
    "",
    "[projects.\"/work/new\"]",
    "trust_level = \"trusted\"",
    "",
    "[mcp_servers.tool]",
    "command = \"tool\"",
    ""
  ].join("\n");
  const snapshot = [
    "model = \"snapshot-model\"",
    "model_provider = \"any\"",
    "approval_policy = \"on-request\"",
    "",
    "[model_providers.any]",
    "base_url = \"https://example.invalid\"",
    "",
    "[projects.\"/work/old\"]",
    "trust_level = \"trusted\"",
    ""
  ].join("\n");

  const merged = mergeAccountConfigText(live, snapshot);
  assert.match(merged, /^model = "snapshot-model"$/m);
  assert.match(merged, /^model_provider = "any"$/m);
  assert.match(merged, /^approval_policy = "never"$/m);
  assert.match(merged, /^\[model_providers\.any]$/m);
  assert.match(merged, /^\[projects\."\/work\/new"]$/m);
  assert.match(merged, /^\[mcp_servers\.tool]$/m);
  assert.doesNotMatch(merged, /live-model|on-request|\/work\/old/);
  assert.equal(readCurrentProviderFromConfigText(merged).provider, "any");
  // Root keys must stay ahead of the first table.
  assert.ok(merged.indexOf("model_provider") < merged.indexOf("["));
});

test("merge drops the live provider tables when the snapshot uses the default provider", () => {
  const live = "model_provider = \"any\"\n\n[model_providers.any]\nbase_url = \"x\"\n\n[tui]\nx = 1\n";
  const merged = mergeAccountConfigText(live, "model = \"gpt\"\n");
  assert.equal(merged, "model = \"gpt\"\n\n[tui]\nx = 1\n");
  assert.equal(readCurrentProviderFromConfigText(merged).provider, "openai");
});
