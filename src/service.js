import fs from "node:fs/promises";
import path from "node:path";

import {
  ACCOUNTS_DIR_NAME,
  AUTH_FILE_NAME,
  DEFAULT_PROVIDER,
  REGISTRY_FILE_NAME,
  defaultCodexHome
} from "./constants.js";
import {
  readConfigText,
  readCurrentProviderFromConfigText
} from "./config-file.js";
import { acquireLock } from "./locking.js";
import {
  applySessionChanges,
  collectSessionChanges,
  restoreSessionChanges,
  splitLockedSessionChanges,
  summarizeProviderCounts
} from "./session-files.js";
import {
  assertSqliteWritable,
  readSqliteProviderCounts,
  updateSqliteProvider
} from "./sqlite-state.js";
import { ANSI, colorEnabled, colorize, padCell } from "./terminal-ui.js";

function normalizeCodexHome(explicitCodexHome) {
  return path.resolve(explicitCodexHome ?? defaultCodexHome());
}

async function ensureCodexHome(codexHome) {
  await fs.access(codexHome);
}

async function readTextFileSnapshot(filePath) {
  try {
    return {
      path: filePath,
      exists: true,
      text: await fs.readFile(filePath, "utf8")
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: filePath,
        exists: false,
        text: null
      };
    }
    throw error;
  }
}

async function restoreTextFileSnapshot(snapshot) {
  if (snapshot.exists) {
    await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
    await fs.writeFile(snapshot.path, snapshot.text, "utf8");
    return;
  }
  await fs.rm(snapshot.path, { force: true });
}

async function restoreTextFileSnapshots(snapshots) {
  const failures = [];
  for (const snapshot of snapshots) {
    try {
      await restoreTextFileSnapshot(snapshot);
    } catch (error) {
      failures.push({
        path: snapshot.path,
        message: error.message
      });
    }
  }
  return failures;
}

function formatRestoreFailures(failures) {
  return failures
    .map((failure) => `${failure.path}: ${failure.message}`)
    .join("; ");
}

function buildTable(headers, rows, options = {}) {
  const enabled = colorEnabled();
  const widths = headers.map((header) => header.length);

  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], String(cell).length);
    });
  }

  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const renderRow = (cells, styleFn = null) => {
    const rendered = cells.map((cell, index) => {
      const raw = padCell(String(cell), widths[index]);
      return styleFn ? colorize(raw, styleFn(index, String(cell)), enabled) : raw;
    });
    return `| ${rendered.join(" | ")} |`;
  };

  const lines = [
    colorize(border, ANSI.dim, enabled),
    colorize(renderRow(headers), ANSI.dim, enabled),
    colorize(border, ANSI.dim, enabled)
  ];

  for (const row of rows) {
    lines.push(renderRow(row, options.cellColor));
  }
  lines.push(colorize(border, ANSI.dim, enabled));
  return lines.join("\n");
}

function buildCountRows(countsByScope) {
  const rows = [];
  for (const scope of ["sessions", "archived_sessions"]) {
    const entries = Object.entries(countsByScope?.[scope] ?? {}).sort(([left], [right]) => left.localeCompare(right));
    if (!entries.length) {
      rows.push([scope, "(none)", "0"]);
      continue;
    }
    for (const [provider, count] of entries) {
      rows.push([scope, provider, String(count)]);
    }
  }
  return rows;
}

export async function getStatus({ codexHome: explicitCodexHome } = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHome(codexHome);
  const configPath = path.join(codexHome, "config.toml");
  const configText = await readConfigText(configPath);
  const current = readCurrentProviderFromConfigText(configText);
  const { providerCounts } = await collectSessionChanges(codexHome, "__status_only__");
  const sqliteCounts = await readSqliteProviderCounts(codexHome);

  return {
    currentProvider: current.provider,
    currentProviderImplicit: current.implicit,
    rolloutCounts: summarizeProviderCounts(providerCounts),
    sqliteCounts
  };
}

export function renderStatus(status) {
  const enabled = colorEnabled();
  const summaryRows = [
    ["Current provider", `${status.currentProvider}${status.currentProviderImplicit ? " (implicit default)" : ""}`]
  ];

  const rolloutRows = buildCountRows(status.rolloutCounts);
  const sqliteRows = status.sqliteCounts
    ? buildCountRows(status.sqliteCounts)
    : [["database", "state_5.sqlite not found", "-"]];

  return [
    colorize("STATUS", ANSI.cyan, enabled),
    buildTable(["FIELD", "VALUE"], summaryRows, {
      cellColor: (index, cell) => {
        if (index !== 1) {
          return null;
        }
        if (cell.startsWith(status.currentProvider)) {
          return ANSI.green;
        }
        if (cell.includes("not found")) {
          return ANSI.yellow;
        }
        return null;
      }
    }),
    "",
    colorize("ROLLOUT FILES", ANSI.cyan, enabled),
    buildTable(["LOCATION", "PROVIDER", "COUNT"], rolloutRows, {
      cellColor: (index, cell) => (index === 1 && cell === status.currentProvider ? ANSI.green : null)
    }),
    "",
    colorize("SQLITE STATE", ANSI.cyan, enabled),
    buildTable(["LOCATION", "PROVIDER", "COUNT"], sqliteRows, {
      cellColor: (index, cell) => {
        if (cell.includes("not found")) {
          return ANSI.yellow;
        }
        if (index === 1 && cell === status.currentProvider) {
          return ANSI.green;
        }
        return null;
      }
    })
  ].join("\n");
}

export async function runSync({
  codexHome: explicitCodexHome,
  provider,
  sqliteBusyTimeoutMs
} = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHome(codexHome);
  const configPath = path.join(codexHome, "config.toml");
  const configText = await readConfigText(configPath);
  const current = readCurrentProviderFromConfigText(configText);
  const targetProvider = provider ?? current.provider ?? DEFAULT_PROVIDER;

  const releaseLock = await acquireLock(codexHome, "sync");
  try {
    const {
      changes,
      lockedPaths: lockedReadPaths,
      providerCounts
    } = await collectSessionChanges(codexHome, targetProvider, { skipLockedReads: true });
    const {
      writableChanges,
      lockedChanges
    } = await splitLockedSessionChanges(changes);
    const skippedRolloutFiles = [...new Set([
      ...lockedReadPaths,
      ...lockedChanges.map((change) => change.path)
    ])].sort((left, right) => left.localeCompare(right));
    await assertSqliteWritable(codexHome, { busyTimeoutMs: sqliteBusyTimeoutMs });

    let sessionRestoreNeeded = false;
    let appliedSessionChanges = [];
    try {
      let applyResult = { appliedChanges: 0, appliedPaths: [], skippedPaths: [] };
      const sqliteResult = await updateSqliteProvider(
        codexHome,
        targetProvider,
        async () => {
          if (writableChanges.length === 0) {
            return;
          }
          applyResult = await applySessionChanges(writableChanges);
          const appliedPathSet = new Set(applyResult.appliedPaths ?? []);
          appliedSessionChanges = writableChanges.filter((change) => appliedPathSet.has(change.path));
          sessionRestoreNeeded = appliedSessionChanges.length > 0;
        },
        { busyTimeoutMs: sqliteBusyTimeoutMs }
      );
      const skippedLockedRolloutFiles = [...new Set([
        ...skippedRolloutFiles,
        ...applyResult.skippedPaths
      ])].sort((left, right) => left.localeCompare(right));
      return {
        codexHome,
        targetProvider,
        previousProvider: current.provider,
        changedSessionFiles: applyResult.appliedChanges,
        skippedLockedRolloutFiles,
        sqliteRowsUpdated: sqliteResult.updatedRows,
        sqlitePresent: sqliteResult.databasePresent,
        rolloutCountsBefore: summarizeProviderCounts(providerCounts)
      };
    } catch (error) {
      if (sessionRestoreNeeded) {
        try {
          await restoreSessionChanges(appliedSessionChanges.map((change) => ({
            path: change.path,
            originalFirstLine: change.originalFirstLine,
            originalSeparator: change.originalSeparator
          })));
        } catch (restoreError) {
          throw new Error(
            `Failed to restore rollout files after sync error. Original error: ${error.message}. Restore error: ${restoreError.message}`
          );
        }
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export async function runSwitch({
  codexHome: explicitCodexHome,
  identifier,
  useAccountFn
}) {
  if (!identifier) {
    throw new Error("Missing account identifier. Usage: cx switch <email|alias>");
  }
  if (!useAccountFn) {
    throw new Error("useAccountFn is required for switch.");
  }

  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHome(codexHome);

  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, AUTH_FILE_NAME);
  const registryPath = path.join(codexHome, ACCOUNTS_DIR_NAME, REGISTRY_FILE_NAME);
  const snapshots = await Promise.all([
    readTextFileSnapshot(configPath),
    readTextFileSnapshot(authPath),
    readTextFileSnapshot(registryPath)
  ]);

  try {
    const useResult = await useAccountFn(codexHome, identifier);
    const newConfigText = await readConfigText(configPath);
    const { provider: newProvider } = readCurrentProviderFromConfigText(newConfigText);

    const syncResult = await runSync({
      codexHome,
      provider: newProvider
    });
    return {
      ...syncResult,
      configUpdated: true,
      switchedAccount: useResult
    };
  } catch (error) {
    const restoreFailures = await restoreTextFileSnapshots(snapshots);
    if (restoreFailures.length > 0) {
      throw new Error(
        `Failed to restore switch state after sync error. Original error: ${error.message}. Restore error(s): ${formatRestoreFailures(restoreFailures)}`
      );
    }
    throw error;
  }
}
