import { DEFAULT_PROVIDER } from "./constants.js";
import { readTextIfExists } from "./fs-utils.js";

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

/**
 * @typedef {{ line: string, kind: "trivia" | "cont" } | { line: string, kind: "header" | "stmt", path: string[] }} TomlLine
 * @typedef {{ path: string[] | null, lines: string[] }} RootItem a root statement with its continuation lines, or trivia
 * @typedef {{ path: string[], lines: string[] }} TomlTable a table header and every line up to the next one
 */

/** @param {string} text */
function splitLines(text) {
  return text.split(/\r?\n/);
}

/** @param {string} text */
function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * @param {string} text
 * @param {number} index
 */
function skipBlanks(text, index) {
  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }
  return index;
}

// Reads a dotted key such as `a."b.c".d` starting at `start`.
/**
 * @param {string} text
 * @param {number} start
 */
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
/**
 * @param {string[]} lines
 * @returns {TomlLine[]}
 */
function classifyTomlLines(lines) {
  /** @type {string | null} */
  let state = null;
  let depth = 0;

  return lines.map((line) => {
    const trimmed = line.trim();
    /** @type {TomlLine} */
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
/** @param {string} text */
function parseTomlSegments(text) {
  /** @type {RootItem[]} */
  const root = [];
  /** @type {TomlTable[]} */
  const tables = [];
  /** @type {TomlTable | null} */
  let currentTable = null;

  for (const entry of classifyTomlLines(splitLines(text))) {
    if (entry.kind === "header") {
      currentTable = { path: entry.path, lines: [entry.line] };
      tables.push(currentTable);
    } else if (currentTable) {
      currentTable.lines.push(entry.line);
    } else if (entry.kind === "cont" && root.length) {
      root[root.length - 1].lines.push(entry.line);
    } else {
      root.push({ path: entry.kind === "stmt" ? entry.path : null, lines: [entry.line] });
    }
  }

  return { root, tables };
}

/**
 * The value of `key = "string"`, or null for any other value.
 * @param {string} statementText
 * @returns {string | null}
 */
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

/**
 * @param {RootItem[]} items
 * @param {string} key
 */
function findStatementString(items, key) {
  const item = items.find((entry) => entry.path?.length === 1 && entry.path[0] === key);
  return item ? parseTomlStringValue(item.lines.join("\n")) : null;
}

/**
 * @param {TomlTable} table
 * @returns {RootItem[]}
 */
function tableStatements(table) {
  return classifyTomlLines(table.lines.slice(1))
    .flatMap((entry) => (entry.kind === "stmt" ? [{ path: entry.path, lines: [entry.line] }] : []));
}

// A missing config.toml is valid: Codex then runs with its defaults, which the
// empty text describes (the default provider).
/** @param {string} configPath */
export async function readConfigText(configPath) {
  return (await readTextIfExists(configPath)) ?? "";
}

/**
 * The provider Codex uses: the active profile's, else the root one, else the default.
 * @param {string} configText
 * @returns {{ provider: string, implicit: boolean }}
 */
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

/** @param {RootItem} item */
function isAccountRootItem(item) {
  return item.path !== null && (ACCOUNT_ROOT_KEYS.has(item.path[0]) || ACCOUNT_TABLE_KEYS.has(item.path[0]));
}

/** @param {TomlTable} table */
function isAccountTable(table) {
  return ACCOUNT_TABLE_KEYS.has(table.path[0]);
}

/**
 * The live items with the account items swapped for the snapshot's, placed
 * where the first live account item was (or at `fallbackIndex`).
 * @template {RootItem} T
 * @param {T[]} liveItems
 * @param {T[]} snapshotItems
 * @param {(item: T) => boolean} isAccountItem
 * @param {(kept: T[]) => number} fallbackIndex
 */
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
/**
 * @param {string} liveText
 * @param {string} snapshotText
 */
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
  while (lines.length && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return `${lines.join(newline)}${newline}`;
}
