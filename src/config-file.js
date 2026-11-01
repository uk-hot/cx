import fs from "node:fs/promises";

import { DEFAULT_PROVIDER } from "./constants.js";

// Root keys that describe which provider/model an account talks to. On a
// switch these come from the target account's snapshot; every other setting
// (projects, MCP servers, approval policy, TUI state, ...) stays as it is in the
// live config.toml.
const ACCOUNT_ROOT_KEYS = new Set([
  "model_provider",
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "model_context_window",
  "model_auto_compact_token_limit",
  "service_tier",
  "profile",
  "preferred_auth_method",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
  "chatgpt_base_url",
  "openai_base_url"
]);
const ACCOUNT_TABLE_KEYS = new Set(["model_providers", "profiles"]);

function splitLines(text) {
  return text.split(/\r?\n/);
}

function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function escapeTomlString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function skipBlanks(text, index) {
  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }
  return index;
}

// Reads a dotted key such as `a."b.c".d` starting at `start`.
function readKeyPath(text, start) {
  const components = [];
  let index = start;
  while (index < text.length) {
    index = skipBlanks(text, index);
    const quote = text[index];
    let component = "";
    if (quote === "\"" || quote === "'") {
      for (index += 1; index < text.length && text[index] !== quote; index += 1) {
        if (quote === "\"" && text[index] === "\\") {
          index += 1;
        }
        component += text[index] ?? "";
      }
      index += 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index));
      if (!match) {
        break;
      }
      component = match[0];
      index += component.length;
    }
    components.push(component);
    index = skipBlanks(text, index);
    if (text[index] !== ".") {
      break;
    }
    index += 1;
  }
  return components;
}

// Classifies each line as a table header, the start of a key/value statement,
// a continuation of a multi-line value, or trivia (blank/comment). Tracks
// strings and bracket depth so `[` inside multi-line strings or arrays is not
// mistaken for a table header.
function classifyTomlLines(lines) {
  let state = null;
  let depth = 0;

  return lines.map((line) => {
    const trimmed = line.trim();
    let entry;
    if (state !== null || depth > 0) {
      entry = { line, kind: "cont" };
    } else if (!trimmed || trimmed.startsWith("#")) {
      return { line, kind: "trivia" };
    } else if (trimmed.startsWith("[")) {
      return {
        line,
        kind: "header",
        path: readKeyPath(trimmed, trimmed.startsWith("[[") ? 2 : 1)
      };
    } else {
      entry = { line, kind: "stmt", path: readKeyPath(line, 0) };
    }

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (state === "\"\"\"" || state === "\"") {
        if (char === "\\") {
          index += 1;
        } else if (state === "\"" ? char === "\"" : line.startsWith("\"\"\"", index)) {
          index += state.length - 1;
          state = null;
        }
        continue;
      }
      if (state === "'''" || state === "'") {
        if (state === "'" ? char === "'" : line.startsWith("'''", index)) {
          index += state.length - 1;
          state = null;
        }
        continue;
      }
      if (char === "#") {
        break;
      }
      if (line.startsWith("\"\"\"", index) || line.startsWith("'''", index)) {
        state = line.slice(index, index + 3);
        index += 2;
      } else if (char === "\"" || char === "'") {
        state = char;
      } else if (char === "[" || char === "{") {
        depth += 1;
      } else if ((char === "]" || char === "}") && depth > 0) {
        depth -= 1;
      }
    }
    // Single-line strings cannot span lines; recover from malformed input.
    if (state === "\"" || state === "'") {
      state = null;
    }
    return entry;
  });
}

// Splits a TOML document into root items ({ path, lines }) and tables
// ({ path, lines }), keeping every original line so it can be re-joined.
function parseTomlSegments(text) {
  const root = [];
  const tables = [];
  let currentTable = null;

  for (const entry of classifyTomlLines(splitLines(text))) {
    if (entry.kind === "header") {
      currentTable = { path: entry.path, lines: [entry.line] };
      tables.push(currentTable);
    } else if (currentTable) {
      currentTable.lines.push(entry.line);
    } else if (entry.kind === "cont" && root.length) {
      root.at(-1).lines.push(entry.line);
    } else {
      root.push({ path: entry.kind === "stmt" ? entry.path : null, lines: [entry.line] });
    }
  }

  return { root, tables };
}

function parseTomlStringValue(statementText) {
  const eqIndex = statementText.indexOf("=");
  if (eqIndex === -1) {
    return null;
  }
  const value = statementText.slice(skipBlanks(statementText, eqIndex + 1));
  if (value.startsWith("\"\"\"") || value.startsWith("'''")) {
    return null;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? null : value.slice(1, end);
  }
  if (value.startsWith("\"")) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] === "\\") {
        index += 1;
      } else if (value[index] === "\"") {
        try {
          return JSON.parse(value.slice(0, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function findStatementString(items, key) {
  const item = items.find((entry) => entry.path?.length === 1 && entry.path[0] === key);
  return item ? parseTomlStringValue(item.lines.join("\n")) : null;
}

function tableStatements(table) {
  return classifyTomlLines(table.lines.slice(1))
    .filter((entry) => entry.kind === "stmt")
    .map((entry) => ({ path: entry.path, lines: [entry.line] }));
}

// A missing config.toml is valid: Codex then runs with its defaults, which the
// empty text describes (the default provider).
export async function readConfigText(configPath) {
  try {
    return await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function readCurrentProviderFromConfigText(configText) {
  const { root, tables } = parseTomlSegments(configText);

  // An active profile's model_provider takes precedence over the root one.
  const profile = findStatementString(root, "profile");
  if (profile) {
    const profileTable = tables.find((table) => table.path.length === 2
      && table.path[0] === "profiles"
      && table.path[1] === profile);
    const profileProvider = profileTable ? findStatementString(tableStatements(profileTable), "model_provider") : null;
    if (profileProvider) {
      return { provider: profileProvider, implicit: false };
    }
  }

  const provider = findStatementString(root, "model_provider");
  if (provider) {
    return { provider, implicit: false };
  }
  return { provider: DEFAULT_PROVIDER, implicit: true };
}

function isAccountRootItem(item) {
  return item.path !== null && (ACCOUNT_ROOT_KEYS.has(item.path[0]) || ACCOUNT_TABLE_KEYS.has(item.path[0]));
}

function isAccountTable(table) {
  return ACCOUNT_TABLE_KEYS.has(table.path[0]);
}

function replaceItems(liveItems, snapshotItems, isAccountItem, fallbackIndex) {
  const kept = [];
  let insertIndex = -1;
  for (const item of liveItems) {
    if (isAccountItem(item)) {
      if (insertIndex === -1) {
        insertIndex = kept.length;
      }
      continue;
    }
    kept.push(item);
  }
  kept.splice(insertIndex === -1 ? fallbackIndex(kept) : insertIndex, 0, ...snapshotItems.filter(isAccountItem));
  return kept;
}

// Builds the config.toml for a switch: provider/model settings from the target
// account's snapshot, everything else from the live config.
export function mergeAccountConfigText(liveText, snapshotText) {
  const newline = detectNewline(liveText);
  const live = parseTomlSegments(liveText);
  const snapshot = parseTomlSegments(snapshotText);

  const root = replaceItems(
    live.root,
    snapshot.root,
    isAccountRootItem,
    (kept) => kept.findLastIndex((item) => item.path !== null) + 1
  );
  const tables = replaceItems(live.tables, snapshot.tables, isAccountTable, (kept) => kept.length);

  const lines = [...root, ...tables].flatMap((item) => item.lines);
  while (lines.length && lines.at(-1).trim() === "") {
    lines.pop();
  }
  return `${lines.join(newline)}${newline}`;
}

export function listConfiguredProviderIds(configText) {
  const providerIds = new Set([DEFAULT_PROVIDER]);
  const regex = /^\[model_providers\.([A-Za-z0-9_.-]+)]\s*$/gm;
  for (const match of configText.matchAll(regex)) {
    providerIds.add(match[1]);
  }
  return [...providerIds].sort();
}

export function configDeclaresProvider(configText, provider) {
  return listConfiguredProviderIds(configText).includes(provider);
}

export function setRootProviderInConfigText(configText, provider) {
  const newline = detectNewline(configText);
  const lines = splitLines(configText);
  let insertIndex = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      insertIndex = index + 1;
      continue;
    }
    if (trimmed.startsWith("[")) {
      insertIndex = index;
      break;
    }
    if (/^model_provider\s*=/.test(trimmed)) {
      lines[index] = `model_provider = "${escapeTomlString(provider)}"`;
      return lines.join(newline);
    }
    insertIndex = index + 1;
  }

  lines.splice(insertIndex, 0, `model_provider = "${escapeTomlString(provider)}"`);
  return lines.join(newline);
}

export async function writeConfigText(configPath, configText) {
  await fs.writeFile(configPath, configText, "utf8");
}
