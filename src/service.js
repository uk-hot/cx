import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomically } from "./auth-service.js";
import {
  ACCOUNTS_DIR_NAME,
  AUTH_FILE_NAME,
  DEFAULT_PROVIDER,
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
import { ANSI, buildTable, colorEnabled, colorize } from "./terminal-ui.js";

function normalizeCodexHome(explicitCodexHome) {
  return path.resolve(explicitCodexHome ?? defaultCodexHome());
}

async function ensureCodexHome(codexHome) {
  await fs.access(codexHome);
}

async function readTextFileSnapshot(filePath) {
  try {
    const [text, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    return {
      path: filePath,
      exists: true,
      text,
      mode: stat.mode & 0o777
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

// Every file in a directory, plus the directory itself so files created later
// can be told apart and removed on restore.
async function readDirectorySnapshot(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: dirPath, files: [] };
    }
    throw error;
  }
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map((entry) => readTextFileSnapshot(path.join(dirPath, entry.name))));
  return { path: dirPath, files };
}

async function restoreTextFileSnapshot(snapshot) {
  if (snapshot.exists) {
    await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
    // Atomic, so an interrupted restore cannot leave a truncated auth.json.
    await writeFileAtomically(snapshot.path, snapshot.text, { mode: snapshot.mode });
    return;
  }
  await fs.rm(snapshot.path, { force: true });
}

async function restoreTextFileSnapshots(snapshots, directorySnapshots = []) {
  const failures = [];
  const restore = async (filePath, action) => {
    try {
      await action();
    } catch (error) {
      failures.push({
        path: filePath,
        message: error.message
      });
    }
  };

  for (const snapshot of snapshots) {
    await restore(snapshot.path, () => restoreTextFileSnapshot(snapshot));
  }
  for (const directory of directorySnapshots) {
    const known = new Set(directory.files.map((file) => file.path));
    const current = await fs.readdir(directory.path).catch(() => []);
    for (const name of current) {
      const filePath = path.join(directory.path, name);
      if (!known.has(filePath)) {
        await restore(filePath, () => fs.rm(filePath, { force: true }));
      }
    }
    for (const snapshot of directory.files) {
      await restore(snapshot.path, () => restoreTextFileSnapshot(snapshot));
    }
  }
  return failures;
}

function formatRestoreFailures(failures) {
  return failures
    .map((failure) => `${failure.path}: ${failure.message}`)
    .join("; ");
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
  const { providerCounts } = await collectSessionChanges(codexHome, null, {
    statusOnly: true,
    skipLockedReads: true
  });
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

async function restoreAppliedOrThrow(appliedChanges, causeError) {
  if (!appliedChanges.length) {
    return;
  }
  try {
    await restoreSessionChanges(appliedChanges.map((change) => ({
      path: change.path,
      originalFirstLine: change.originalFirstLine,
      originalSeparator: change.originalSeparator
    })));
  } catch (restoreError) {
    throw new Error(
      `Failed to restore rollout files after sync error. Original error: ${causeError.message}. Restore error: ${restoreError.message}`
    );
  }
}

async function runSyncLocked({
  codexHome,
  provider,
  sqliteBusyTimeoutMs
}) {
  const configPath = path.join(codexHome, "config.toml");
  const configText = await readConfigText(configPath);
  const current = readCurrentProviderFromConfigText(configText);
  const targetProvider = provider ?? current.provider ?? DEFAULT_PROVIDER;

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

  // Verify the database is writable before rewriting any rollout file, so we
  // do not touch files only to discover the database is locked afterwards.
  await assertSqliteWritable(codexHome, { busyTimeoutMs: sqliteBusyTimeoutMs });

  // 1) Rewrite rollout files first, outside of any SQLite transaction, so the
  //    database write lock (step 2) stays short regardless of file count.
  let applyResult;
  try {
    applyResult = await applySessionChanges(writableChanges);
  } catch (error) {
    const appliedPathSet = new Set(error.appliedPaths ?? []);
    await restoreAppliedOrThrow(
      writableChanges.filter((change) => appliedPathSet.has(change.path)),
      error
    );
    throw error;
  }
  const appliedPathSet = new Set(applyResult.appliedPaths);
  const appliedSessionChanges = writableChanges.filter((change) => appliedPathSet.has(change.path));

  const skippedLockedRolloutFiles = [...new Set([
    ...skippedRolloutFiles,
    ...applyResult.skippedPaths
  ])].sort((left, right) => left.localeCompare(right));
  const changeByPath = new Map(changes.map((change) => [change.path, change]));
  const skippedThreadIds = skippedLockedRolloutFiles
    .map((filePath) => changeByPath.get(filePath)?.threadId)
    .filter(Boolean);

  // 2) Update SQLite in a short transaction. On failure, roll the rewritten
  //    rollout files back so both stores stay consistent.
  let sqliteResult;
  try {
    sqliteResult = await updateSqliteProvider(codexHome, targetProvider, {
      busyTimeoutMs: sqliteBusyTimeoutMs,
      skippedThreadIds,
      skippedRolloutPaths: skippedLockedRolloutFiles
    });
  } catch (error) {
    await restoreAppliedOrThrow(appliedSessionChanges, error);
    throw error;
  }

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
}

export async function runSync({
  codexHome: explicitCodexHome,
  provider,
  sqliteBusyTimeoutMs
} = {}) {
  const codexHome = normalizeCodexHome(explicitCodexHome);
  await ensureCodexHome(codexHome);

  const releaseLock = await acquireLock(codexHome, "sync");
  try {
    return await runSyncLocked({ codexHome, provider, sqliteBusyTimeoutMs });
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

  const releaseLock = await acquireLock(codexHome, "switch");
  try {
    const configPath = path.join(codexHome, "config.toml");
    const authPath = path.join(codexHome, AUTH_FILE_NAME);
    const snapshots = await Promise.all([
      readTextFileSnapshot(configPath),
      readTextFileSnapshot(authPath)
    ]);
    // The registry and the account snapshots: a switch refreshes the outgoing
    // account's snapshots and may register the live login with new ones.
    const accountsSnapshot = await readDirectorySnapshot(path.join(codexHome, ACCOUNTS_DIR_NAME));

    try {
      const useResult = await useAccountFn(codexHome, identifier);
      const newConfigText = await readConfigText(configPath);
      const { provider: newProvider } = readCurrentProviderFromConfigText(newConfigText);

      const syncResult = await runSyncLocked({
        codexHome,
        provider: newProvider
      });
      return {
        ...syncResult,
        configUpdated: true,
        switchedAccount: useResult
      };
    } catch (error) {
      const restoreFailures = await restoreTextFileSnapshots(snapshots, [accountsSnapshot]);
      if (restoreFailures.length > 0) {
        throw new Error(
          `Failed to restore switch state after sync error. Original error: ${error.message}. Restore error(s): ${formatRestoreFailures(restoreFailures)}`
        );
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}
