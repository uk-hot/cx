import fs from "node:fs/promises";
import path from "node:path";

import { readRecentRolloutPaths } from "./sqlite-state.js";

// Whether someone is working with Codex right now. Every Codex session, in the
// terminal or the app, appends to its rollout file as it goes, so a rollout
// written in the last few minutes means Codex is in use. cx warm's own requests
// run --ephemeral in a private home and write none.

export const CODEX_ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const RECENT_DAYS = 2;
const RECENT_THREADS = 5;

/**
 * Subdirectories, newest name first; sessions/ is laid out as YYYY/MM/DD.
 * @param {string} dir
 */
async function subdirsNewestFirst(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** @param {string} sessionsDir */
async function recentDayDirs(sessionsDir) {
  /** @type {string[]} */
  const days = [];
  for (const year of await subdirsNewestFirst(sessionsDir)) {
    for (const month of await subdirsNewestFirst(year)) {
      for (const day of await subdirsNewestFirst(month)) {
        days.push(day);
        if (days.length >= RECENT_DAYS) {
          return days;
        }
      }
    }
  }
  return days;
}

/**
 * When Codex last wrote a session, or null if never. New sessions live in the
 * latest day directories; a resumed one keeps writing to its old file, which
 * the state database lists among the threads updated last.
 * @param {string} codexHome
 */
export async function lastCodexActivity(codexHome) {
  /** @type {string[]} */
  const candidates = [];
  for (const day of await recentDayDirs(path.join(codexHome, "sessions"))) {
    const names = await fs.readdir(day).catch(() => /** @type {string[]} */ ([]));
    candidates.push(...names.filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl")).map((name) => path.join(day, name)));
  }
  candidates.push(...await readRecentRolloutPaths(codexHome, RECENT_THREADS).catch(() => []));
  let latest = null;
  for (const file of new Set(candidates)) {
    const mtime = await fs.stat(file).then((stat) => stat.mtimeMs, () => null);
    if (mtime !== null && (latest === null || mtime > latest)) {
      latest = mtime;
    }
  }
  return latest;
}

/**
 * @param {string} codexHome
 * @param {number} [now]
 */
export async function isCodexActive(codexHome, now = Date.now()) {
  const last = await lastCodexActivity(codexHome);
  return last !== null && now - last < CODEX_ACTIVE_WINDOW_MS;
}
