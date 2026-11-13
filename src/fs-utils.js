import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** @param {unknown} error */
export function isNotFound(error) {
  return /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";
}

/** @param {unknown} error */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The file's text, or null when it does not exist.
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
export async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/** @param {string} filePath */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @param {number} fallbackMode
 */
export async function fileModeOr(filePath, fallbackMode) {
  try {
    return (await fs.stat(filePath)).mode & 0o777;
  } catch {
    return fallbackMode;
  }
}

/**
 * A unique temporary path next to `filePath`, so a rename onto it stays on the
 * same filesystem.
 * @param {string} filePath
 */
export function temporaryPathFor(filePath) {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * Writes through a temporary file and a rename, so readers never see a
 * truncated file. Defaults to owner-only, as most files cx writes hold tokens.
 * @param {string} filePath
 * @param {string} text
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomically(filePath, text, { mode = 0o600 } = {}) {
  const temporaryPath = temporaryPathFor(filePath);
  try {
    await fs.writeFile(temporaryPath, text, { encoding: "utf8", mode });
    await fs.chmod(temporaryPath, mode);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * @typedef {{ path: string, exists: true, text: string, mode: number } | { path: string, exists: false }} FileSnapshot
 * @typedef {{ path: string, files: FileSnapshot[] }} DirectorySnapshot
 */

/**
 * @param {string} filePath
 * @returns {Promise<FileSnapshot>}
 */
export async function snapshotFile(filePath) {
  try {
    const [text, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    return { path: filePath, exists: true, text, mode: stat.mode & 0o777 };
  } catch (error) {
    if (isNotFound(error)) {
      return { path: filePath, exists: false };
    }
    throw error;
  }
}

/**
 * Every file in a directory, plus the directory itself so files created later
 * can be told apart and removed on restore.
 * @param {string} dirPath
 * @returns {Promise<DirectorySnapshot>}
 */
export async function snapshotDirectory(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return { path: dirPath, files: [] };
    }
    throw error;
  }
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map((entry) => snapshotFile(path.join(dirPath, entry.name))));
  return { path: dirPath, files };
}

/** @param {FileSnapshot} snapshot */
async function restoreFile(snapshot) {
  if (snapshot.exists) {
    await fs.mkdir(path.dirname(snapshot.path), { recursive: true });
    // Atomic, so an interrupted restore cannot leave a truncated auth.json.
    await writeFileAtomically(snapshot.path, snapshot.text, { mode: snapshot.mode });
    return;
  }
  await fs.rm(snapshot.path, { force: true });
}

/**
 * Puts files and directories back as snapshotted. Keeps going past failures and
 * returns them, so one stuck file does not stop the rest from being restored.
 * @param {FileSnapshot[]} files
 * @param {DirectorySnapshot[]} [directories]
 * @returns {Promise<{ path: string, message: string }[]>}
 */
export async function restoreSnapshots(files, directories = []) {
  /** @type {{ path: string, message: string }[]} */
  const failures = [];
  /**
   * @param {string} filePath
   * @param {() => Promise<void>} action
   */
  const attempt = async (filePath, action) => {
    try {
      await action();
    } catch (error) {
      failures.push({ path: filePath, message: errorMessage(error) });
    }
  };

  for (const snapshot of files) {
    await attempt(snapshot.path, () => restoreFile(snapshot));
  }
  for (const directory of directories) {
    const known = new Set(directory.files.map((file) => file.path));
    const current = await fs.readdir(directory.path).catch(() => []);
    for (const name of current) {
      const filePath = path.join(directory.path, name);
      if (!known.has(filePath)) {
        await attempt(filePath, () => fs.rm(filePath, { force: true }));
      }
    }
    for (const snapshot of directory.files) {
      await attempt(snapshot.path, () => restoreFile(snapshot));
    }
  }
  return failures;
}

/** @param {{ path: string, message: string }[]} failures */
export function formatFailures(failures) {
  return failures.map((failure) => `${failure.path}: ${failure.message}`).join("; ");
}
