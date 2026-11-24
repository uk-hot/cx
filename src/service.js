import fs from "node:fs/promises";

import { useAccount } from "./accounts.js";
import { readConfigText, readCurrentProviderFromConfigText } from "./config-file.js";
import { DEFAULT_PROVIDER, SESSION_DIRS, codexPaths } from "./constants.js";
import { errorMessage, formatFailures, restoreSnapshots, snapshotDirectory, snapshotFile } from "./fs-utils.js";
import { withLock } from "./locking.js";
import {
  RolloutRewriteError,
  applySessionChanges,
  collectSessionChanges,
  restoreSessionChanges,
  splitLockedSessionChanges,
  summarizeProviderCounts
} from "./session-files.js";
import { assertSqliteWritable, readOffsetAddressedThreadIds, readSqliteProviderCounts, updateSqliteProvider } from "./sqlite-state.js";
import { ANSI, buildTable, colorEnabled, colorize } from "./terminal-ui.js";

/** @typedef {import("./session-files.js").RolloutChange} RolloutChange */
/** @typedef {Record<string, Record<string, number>>} CountsByScope */

/**
 * @typedef {object} SyncResult
 * @property {string} codexHome
 * @property {string} targetProvider
 * @property {number} changedSessionFiles
 * @property {string[]} skippedLockedRolloutFiles rollouts left for a later sync because they were in use
 * @property {string[]} oversizedRolloutFiles rollouts left on their provider: the
 *   new header is longer, and Codex addresses them by byte offset
 * @property {string[]} liveRolloutFiles rollouts rewritten in place while Codex
 *   had them open; it may write their creator tags back to SQLite until it
 *   closes them
 * @property {number} sqliteRowsUpdated
 * @property {boolean} sqlitePresent
 */

/** @param {string} codexHome */
async function assertCodexHome(codexHome) {
  await fs.access(codexHome);
}

/** @param {string} codexHome */
async function readCurrentProvider(codexHome) {
  return readCurrentProviderFromConfigText(await readConfigText(codexPaths(codexHome).config));
}

/** @param {string[]} paths */
const uniqueSorted = (paths) => [...new Set(paths)].sort((left, right) => left.localeCompare(right));

/** @param {CountsByScope | null} countsByScope */
function buildCountRows(countsByScope) {
  const rows = [];
  for (const scope of SESSION_DIRS) {
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

/** @param {{ codexHome: string }} options */
export async function getStatus({ codexHome }) {
  await assertCodexHome(codexHome);
  const current = await readCurrentProvider(codexHome);
  const { providerCounts } = await collectSessionChanges(codexHome, null, { statusOnly: true });

  return {
    currentProvider: current.provider,
    currentProviderImplicit: current.implicit,
    rolloutCounts: summarizeProviderCounts(providerCounts),
    sqliteCounts: await readSqliteProviderCounts(codexHome)
  };
}

/** @param {Awaited<ReturnType<typeof getStatus>>} status */
export function renderStatus(status) {
  const enabled = colorEnabled();
  /** @param {number} index @param {string} cell */
  const providerColor = (index, cell) => (index === 1 && cell === status.currentProvider ? ANSI.green : null);
  const sqliteRows = status.sqliteCounts
    ? buildCountRows(status.sqliteCounts)
    : [["database", "state_5.sqlite not found", "-"]];

  return [
    colorize("STATUS", ANSI.cyan, enabled),
    buildTable(["FIELD", "VALUE"], [
      ["Current provider", `${status.currentProvider}${status.currentProviderImplicit ? " (implicit default)" : ""}`]
    ], {
      cellColor: (index, cell) => (index === 1 && cell.startsWith(status.currentProvider) ? ANSI.green : null)
    }),
    "",
    colorize("ROLLOUT FILES", ANSI.cyan, enabled),
    buildTable(["LOCATION", "PROVIDER", "COUNT"], buildCountRows(status.rolloutCounts), { cellColor: providerColor }),
    "",
    colorize("SQLITE STATE", ANSI.cyan, enabled),
    buildTable(["LOCATION", "PROVIDER", "COUNT"], sqliteRows, {
      cellColor: (index, cell) => (cell.includes("not found") ? ANSI.yellow : providerColor(index, cell))
    })
  ].join("\n");
}

/**
 * Rolls rewritten rollouts back after a failure, then rethrows the failure.
 * @param {RolloutChange[]} appliedChanges
 * @param {unknown} causeError
 * @returns {Promise<never>}
 */
async function restoreAndThrow(appliedChanges, causeError) {
  try {
    await restoreSessionChanges(appliedChanges);
  } catch (restoreError) {
    throw new Error(
      `Failed to restore rollout files after sync error (${errorMessage(causeError)}). ${errorMessage(restoreError)}`,
      { cause: causeError }
    );
  }
  throw causeError;
}

/**
 * Moves every rollout and thread row to the target provider and clears their
 * account scope. Rollouts first, then one short SQLite transaction; a failure
 * in either rolls the rewritten rollouts back. Callers must hold the cx lock.
 * @param {{ codexHome: string, provider?: string }} options
 * @returns {Promise<SyncResult>}
 */
async function runSyncLocked({ codexHome, provider }) {
  const targetProvider = provider ?? (await readCurrentProvider(codexHome)).provider ?? DEFAULT_PROVIDER;

  const offsetThreadIds = await readOffsetAddressedThreadIds(codexHome);
  const { changes, lockedPaths, oversized } = await collectSessionChanges(codexHome, targetProvider, { offsetThreadIds });
  const { writableChanges, lockedChanges, liveChanges } = await splitLockedSessionChanges(codexHome, changes);

  // Verify the database is writable before rewriting any rollout file, so we
  // do not touch files only to discover the database is locked afterwards.
  await assertSqliteWritable(codexHome);

  /** @param {string[]} paths */
  const changesAt = (paths) => {
    const pathSet = new Set(paths);
    return writableChanges.filter((change) => pathSet.has(change.path));
  };

  let applied;
  try {
    applied = await applySessionChanges(writableChanges);
  } catch (error) {
    return restoreAndThrow(changesAt(error instanceof RolloutRewriteError ? error.appliedPaths : []), error);
  }

  const skippedLockedRolloutFiles = uniqueSorted([
    ...lockedPaths,
    ...lockedChanges.map((change) => change.path),
    ...applied.skippedPaths
  ]);
  const threadIdByPath = new Map(changes.map((change) => [change.path, change.threadId]));
  const skippedThreadIds = [
    ...skippedLockedRolloutFiles.map((filePath) => threadIdByPath.get(filePath)),
    ...oversized.map((entry) => entry.threadId)
  ].filter((threadId) => typeof threadId === "string");
  const oversizedRolloutFiles = oversized.map((entry) => entry.path);
  const appliedPaths = new Set(applied.appliedPaths);

  let sqliteResult;
  try {
    // Rows of untouched rollouts keep their provider and creator, so the two
    // stores agree.
    sqliteResult = await updateSqliteProvider(codexHome, targetProvider, {
      skippedThreadIds,
      skippedRolloutPaths: [...skippedLockedRolloutFiles, ...oversizedRolloutFiles]
    });
  } catch (error) {
    return restoreAndThrow(changesAt(applied.appliedPaths), error);
  }

  return {
    codexHome,
    targetProvider,
    changedSessionFiles: applied.appliedPaths.length,
    skippedLockedRolloutFiles,
    oversizedRolloutFiles,
    liveRolloutFiles: liveChanges.map((change) => change.path).filter((filePath) => appliedPaths.has(filePath)),
    sqliteRowsUpdated: sqliteResult.updatedRows,
    sqlitePresent: sqliteResult.databasePresent
  };
}

/** @param {{ codexHome: string, provider?: string }} options */
export async function runSync({ codexHome, provider }) {
  await assertCodexHome(codexHome);
  return withLock(codexHome, "sync", () => runSyncLocked({ codexHome, provider }));
}

/**
 * Switches the login to a registered account and syncs the sessions to its
 * provider. Snapshots auth.json, config.toml and the accounts directory first,
 * and puts them back if either step fails. `signIn`: the account's saved login
 * is dead, so Codex is left signed out to sign in again (see useAccount).
 * @param {{ codexHome: string, identifier: string | undefined, signIn?: boolean, useAccountFn?: typeof useAccount }} options
 */
export async function runSwitch({ codexHome, identifier, signIn = false, useAccountFn = useAccount }) {
  if (!identifier) {
    throw new Error("Missing account identifier. Usage: cx switch <email|alias>");
  }
  await assertCodexHome(codexHome);
  const paths = codexPaths(codexHome);

  return withLock(codexHome, "switch", async () => {
    const files = await Promise.all([snapshotFile(paths.config), snapshotFile(paths.auth)]);
    // A switch refreshes the outgoing account's snapshots and may register the
    // live login with new ones.
    const accounts = await snapshotDirectory(paths.accounts);

    try {
      const switchedAccount = await useAccountFn(codexHome, identifier, { signIn });
      const { provider } = await readCurrentProvider(codexHome);
      return { ...await runSyncLocked({ codexHome, provider }), switchedAccount };
    } catch (error) {
      const restoreFailures = await restoreSnapshots(files, [accounts]);
      if (restoreFailures.length > 0) {
        throw new Error(
          `Failed to restore switch state after sync error (${errorMessage(error)}). Restore error(s): ${formatFailures(restoreFailures)}`,
          { cause: error }
        );
      }
      throw error;
    }
  });
}
