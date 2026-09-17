import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SESSION_DIRS } from "./constants.js";

const execFileAsync = promisify(execFile);

function isRolloutFileBusyError(error) {
  const message = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
  return message.includes("ebusy")
    || message.includes("resource busy or locked")
    || message.includes("being used by another process")
    || message.includes("currently in use")
    || message.includes("eperm");
}

function wrapRolloutFileBusyError(error, filePath, action) {
  if (!isRolloutFileBusyError(error)) {
    return error;
  }
  return new Error(
    `Unable to ${action} rollout file because it is currently in use. Close Codex and the Codex app, then retry. Locked file: ${filePath}`
  );
}

async function getFileSnapshot(filePath) {
  const stat = await fsp.stat(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function snapshotMatches(change, snapshot) {
  return change.originalSize === snapshot.size
    && change.originalMtimeMs === snapshot.mtimeMs;
}

async function listJsonlFiles(rootDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readFirstLineRecord(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    let position = 0;
    let collected = Buffer.alloc(0);
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      collected = Buffer.concat([collected, chunk.subarray(0, bytesRead)]);
      const newlineIndex = collected.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const crlf = newlineIndex > 0 && collected[newlineIndex - 1] === 0x0d;
        const lineBuffer = crlf ? collected.subarray(0, newlineIndex - 1) : collected.subarray(0, newlineIndex);
        return {
          firstLine: lineBuffer.toString("utf8"),
          separator: crlf ? "\r\n" : "\n",
          offset: newlineIndex + 1
        };
      }
    }
    return {
      firstLine: collected.toString("utf8"),
      separator: "",
      offset: collected.length
    };
  } catch (error) {
    throw wrapRolloutFileBusyError(error, filePath, "read");
  } finally {
    await handle?.close();
  }
}

function parseSessionMetaRecord(firstLine) {
  if (!firstLine) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || typeof parsed?.payload !== "object" || parsed.payload === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function rewriteFirstLine(filePath, nextFirstLine, separator) {
  const current = await readFirstLineRecord(filePath);
  const tmpPath = `${filePath}.provider-sync.${process.pid}.${Date.now()}.tmp`;
  const writer = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  try {
    await new Promise((resolve, reject) => {
      writer.on("error", reject);
      writer.write(nextFirstLine);
      if (separator) {
        writer.write(separator);
      }

      const headerOnly =
        current.separator === "" &&
        current.offset === Buffer.byteLength(current.firstLine, "utf8");

      if (headerOnly) {
        writer.end();
        writer.once("finish", resolve);
        return;
      }

      const reader = fs.createReadStream(filePath, { start: current.offset });
      reader.on("error", reject);
      reader.on("end", () => writer.end());
      writer.once("finish", resolve);
      reader.pipe(writer, { end: false });
    });

    await fsp.rename(tmpPath, filePath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw wrapRolloutFileBusyError(error, filePath, "rewrite");
  }
}

async function tryRewriteCollectedFirstLine(change) {
  const beforeSnapshot = await getFileSnapshot(change.path);
  if (!snapshotMatches(change, beforeSnapshot)) {
    return false;
  }

  const current = await readFirstLineRecord(change.path);
  if (current.firstLine !== change.originalFirstLine || current.offset !== change.originalOffset) {
    return false;
  }

  const tmpPath = `${change.path}.provider-sync.${process.pid}.${Date.now()}.tmp`;
  const writer = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  try {
    await new Promise((resolve, reject) => {
      writer.on("error", reject);
      writer.write(change.updatedFirstLine);
      if (change.originalSeparator) {
        writer.write(change.originalSeparator);
      }

      const headerOnly = change.originalOffset >= change.originalSize;
      if (headerOnly) {
        writer.end();
        writer.once("finish", resolve);
        return;
      }

      const reader = fs.createReadStream(change.path, { start: change.originalOffset });
      reader.on("error", reject);
      reader.on("end", () => writer.end());
      writer.once("finish", resolve);
      reader.pipe(writer, { end: false });
    });

    const afterSnapshot = await getFileSnapshot(change.path);
    if (!snapshotMatches(change, afterSnapshot)) {
      await fsp.rm(tmpPath, { force: true });
      return false;
    }

    await fsp.rename(tmpPath, change.path);
    return true;
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw wrapRolloutFileBusyError(error, change.path, "rewrite");
  }
}

async function findLockedFilesOnWindows(filePaths) {
  if (!filePaths.length) {
    return [];
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-provider-locks-"));
  const manifestPath = path.join(tempDir, "paths.json");
  const script = `
& {
  param([string]$manifestPath)
  $paths = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
  foreach ($path in $paths) {
    try {
      $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $stream.Close()
    } catch {
      Write-Output $path
    }
  }
}
`.trim();

  try {
    await fsp.writeFile(manifestPath, JSON.stringify(filePaths), "utf8");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      manifestPath
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`Unable to verify rollout file locks on Windows. ${error.message}`);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

export async function collectSessionChanges(codexHome, targetProvider, options = {}) {
  const {
    skipLockedReads = false,
    statusOnly = false
  } = options;
  const summaries = [];
  const lockedPaths = [];
  const providerCounts = Object.fromEntries(SESSION_DIRS.map((dirName) => [dirName, new Map()]));

  for (const dirName of SESSION_DIRS) {
    const rootDir = path.join(codexHome, dirName);
    try {
      await fsp.access(rootDir);
    } catch {
      continue;
    }
    const rolloutPaths = await listJsonlFiles(rootDir);
    for (const rolloutPath of rolloutPaths) {
      let record;
      try {
        record = await readFirstLineRecord(rolloutPath);
      } catch (error) {
        if (skipLockedReads && isRolloutFileBusyError(error)) {
          lockedPaths.push(rolloutPath);
          continue;
        }
        throw error;
      }
      const parsed = parseSessionMetaRecord(record.firstLine);
      if (!parsed) {
        continue;
      }
      const currentProvider = parsed.payload.model_provider ?? "(missing)";
      providerCounts[dirName].set(currentProvider, (providerCounts[dirName].get(currentProvider) ?? 0) + 1);

      if (!statusOnly && parsed.payload.model_provider !== targetProvider) {
        const snapshot = await getFileSnapshot(rolloutPath);
        parsed.payload.model_provider = targetProvider;
        summaries.push({
          path: rolloutPath,
          threadId: parsed.payload.id ?? null,
          directory: dirName,
          originalFirstLine: record.firstLine,
          originalSeparator: record.separator,
          originalOffset: record.offset,
          originalSize: snapshot.size,
          originalMtimeMs: snapshot.mtimeMs,
          updatedFirstLine: JSON.stringify(parsed)
        });
      }
    }
  }

  return { changes: summaries, lockedPaths, providerCounts };
}

const WINDOWS_BATCH_REWRITE_SCRIPT = `
& {
  param([string]$manifestPath)

  function Read-FirstLineRecord([System.IO.FileStream]$stream) {
    $stream.Seek(0, [System.IO.SeekOrigin]::Begin) | Out-Null
    $buffer = New-Object byte[] (64 * 1024)
    $collected = New-Object System.IO.MemoryStream
    try {
      while ($true) {
        $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
        if ($bytesRead -le 0) {
          break
        }

        $collected.Write($buffer, 0, $bytesRead)
        $bytes = $collected.ToArray()
        $newlineIndex = [Array]::IndexOf($bytes, [byte]10)
        if ($newlineIndex -ge 0) {
          $crlf = $newlineIndex -gt 0 -and $bytes[$newlineIndex - 1] -eq [byte]13
          $lineLength = if ($crlf) { $newlineIndex - 1 } else { $newlineIndex }
          return @{
            firstLine = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $lineLength)
            offset = $newlineIndex + 1
          }
        }
      }

      return @{
        firstLine = [System.Text.Encoding]::UTF8.GetString($collected.ToArray())
        offset = [int]$collected.Length
      }
    } finally {
      $collected.Dispose()
    }
  }

  function Invoke-RewriteOne($change, [int]$index) {
    $path = [string]$change.path
    $stamp = "$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).$index"
    $tmpPath = "$path.provider-sync.$stamp.tmp"
    $backupPath = "$path.provider-sync.$stamp.bak"
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $source = $null
    $writer = $null

    try {
      try {
        $source = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      } catch {
        if (Test-Path $path) {
          return "SKIP_BUSY"
        }
        return "SKIP_CHANGED"
      }

      if ([bool]$change.requireOriginalMatch) {
        if ($source.Length -ne [int64]$change.originalSize) {
          return "SKIP_CHANGED"
        }

        $record = Read-FirstLineRecord $source
        if ($record.firstLine -ne [string]$change.originalFirstLine -or $record.offset -ne [int]$change.originalOffset) {
          return "SKIP_CHANGED"
        }

        $separator = [string]$change.originalSeparator
        $sourceOffset = [int64]$change.originalOffset
        $headerOnly = $sourceOffset -ge [int64]$change.originalSize
      } else {
        $record = Read-FirstLineRecord $source
        $separator = [string]$change.separator
        $sourceOffset = [int64]$record.offset
        $headerOnly = $record.offset -ge $source.Length
      }

      $writer = [System.IO.File]::Open($tmpPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      $firstLineBytes = $encoding.GetBytes([string]$change.updatedFirstLine)
      $writer.Write($firstLineBytes, 0, $firstLineBytes.Length)

      if (-not [string]::IsNullOrEmpty($separator)) {
        $separatorBytes = $encoding.GetBytes($separator)
        $writer.Write($separatorBytes, 0, $separatorBytes.Length)
      }

      if (-not $headerOnly) {
        $source.Seek($sourceOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
        $source.CopyTo($writer)
      }

      $writer.Flush()
      $writer.Dispose()
      $writer = $null

      $source.Dispose()
      $source = $null

      try {
        [System.IO.File]::Replace($tmpPath, $path, $backupPath, $true)
      } catch {
        if (-not (Test-Path $path)) {
          return "SKIP_CHANGED"
        }
        throw
      }

      return "APPLIED"
    } finally {
      if ($writer) {
        $writer.Dispose()
      }
      if ($source) {
        $source.Dispose()
      }
      Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue
      Remove-Item -Path $backupPath -Force -ErrorAction SilentlyContinue
    }
  }

  $changes = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
  $index = 0
  foreach ($change in $changes) {
    try {
      $status = Invoke-RewriteOne $change $index
    } catch {
      $status = "ERROR:" + $_.Exception.Message
    }
    Write-Output ($status + "|" + [string]$change.path)
    $index = $index + 1
  }
}
`.trim();

export function parseWindowsRewriteStatuses(stdout) {
  const statusByPath = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("|");
    if (separatorIndex === -1) {
      continue;
    }
    statusByPath.set(trimmed.slice(separatorIndex + 1), trimmed.slice(0, separatorIndex));
  }
  return statusByPath;
}

export function parseWindowsRewriteResults(stdout, changes) {
  const statusByPath = parseWindowsRewriteStatuses(stdout);

  const appliedPaths = [];
  const skippedPaths = [];
  const unexpected = [];
  for (const change of changes) {
    const status = statusByPath.get(change.path);
    if (status === "APPLIED") {
      appliedPaths.push(change.path);
    } else if (status === "SKIP_BUSY" || status === "SKIP_CHANGED") {
      skippedPaths.push(change.path);
    } else {
      unexpected.push(`${change.path}: ${status ?? "(no result)"}`);
    }
  }

  appliedPaths.sort((left, right) => left.localeCompare(right));
  skippedPaths.sort((left, right) => left.localeCompare(right));

  if (unexpected.length > 0) {
    // The PowerShell batch runs to completion before returning, so every
    // APPLIED file is already on disk. Hand the caller the full applied set so
    // it can roll them ALL back — not just the ones before the first error.
    const error = new Error(`Unexpected rewrite result(s): ${unexpected.join("; ")}`);
    error.appliedPaths = appliedPaths;
    throw error;
  }

  return {
    appliedChanges: appliedPaths.length,
    appliedPaths,
    skippedPaths
  };
}

async function runWindowsRewriteBatch(batchChanges) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-provider-rewrite-"));
  const manifestPath = path.join(tempDir, "changes.json");
  try {
    await fsp.writeFile(manifestPath, JSON.stringify(batchChanges), "utf8");
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_BATCH_REWRITE_SCRIPT,
          manifestPath
        ],
        { maxBuffer: 64 * 1024 * 1024 }
      );
      return stdout;
    } catch (error) {
      throw wrapRolloutFileBusyError(error, batchChanges[0]?.path ?? "(unknown)", "rewrite");
    }
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function applySessionChangesWindows(changes) {
  const stdout = await runWindowsRewriteBatch(changes.map((change) => ({
    path: change.path,
    originalSize: change.originalSize,
    originalFirstLine: change.originalFirstLine,
    originalOffset: change.originalOffset,
    originalSeparator: change.originalSeparator,
    updatedFirstLine: change.updatedFirstLine,
    requireOriginalMatch: true
  })));
  return parseWindowsRewriteResults(stdout, changes);
}

export async function applySessionChanges(changes) {
  if (!changes.length) {
    return { appliedChanges: 0, appliedPaths: [], skippedPaths: [] };
  }

  if (process.platform === "win32") {
    return applySessionChangesWindows(changes);
  }

  const skippedPaths = [];
  const appliedPaths = [];

  for (const change of changes) {
    let applied;
    try {
      applied = await tryRewriteCollectedFirstLine(change);
    } catch (error) {
      // Preserve the files already rewritten so the caller can roll them back;
      // otherwise a mid-batch failure would leave them silently changed.
      error.appliedPaths = [...appliedPaths];
      throw error;
    }
    if (applied) {
      appliedPaths.push(change.path);
    } else {
      skippedPaths.push(change.path);
    }
  }

  appliedPaths.sort((left, right) => left.localeCompare(right));
  skippedPaths.sort((left, right) => left.localeCompare(right));
  return {
    appliedChanges: appliedPaths.length,
    appliedPaths,
    skippedPaths
  };
}

export async function assertSessionFilesWritable(changes) {
  if (!changes?.length || process.platform !== "win32") {
    return;
  }

  const lockedPaths = await findLockedFilesOnWindows(changes.map((change) => change.path));
  if (lockedPaths.length === 0) {
    return;
  }

  const preview = lockedPaths.slice(0, 5).join(", ");
  const extraCount = lockedPaths.length - Math.min(lockedPaths.length, 5);
  const suffix = extraCount > 0 ? ` (+${extraCount} more)` : "";
  throw new Error(
    `Unable to rewrite rollout files because ${lockedPaths.length} file(s) are currently in use. Close Codex and the Codex app, then retry. Locked file(s): ${preview}${suffix}`
  );
}

export async function splitLockedSessionChanges(changes) {
  if (!changes?.length || process.platform !== "win32") {
    return {
      writableChanges: changes ?? [],
      lockedChanges: []
    };
  }

  const lockedPaths = new Set(await findLockedFilesOnWindows(changes.map((change) => change.path)));
  if (lockedPaths.size === 0) {
    return {
      writableChanges: changes,
      lockedChanges: []
    };
  }

  const writableChanges = [];
  const lockedChanges = [];
  for (const change of changes) {
    if (lockedPaths.has(change.path)) {
      lockedChanges.push(change);
    } else {
      writableChanges.push(change);
    }
  }

  return {
    writableChanges,
    lockedChanges
  };
}

async function restoreSessionChangesPosix(manifestEntries) {
  const failures = [];
  for (const entry of manifestEntries) {
    try {
      await rewriteFirstLine(entry.path, entry.originalFirstLine, entry.originalSeparator ?? "");
    } catch (error) {
      failures.push({ path: entry.path, message: error.message });
    }
  }
  return failures;
}

export function collectWindowsRestoreFailures(stdout, manifestEntries) {
  const statusByPath = parseWindowsRewriteStatuses(stdout);
  const failures = [];
  for (const entry of manifestEntries) {
    const status = statusByPath.get(entry.path);
    if (status !== "APPLIED") {
      failures.push({ path: entry.path, message: `rewrite result: ${status ?? "(no result)"}` });
    }
  }
  return failures;
}

async function restoreSessionChangesWindows(manifestEntries) {
  const stdout = await runWindowsRewriteBatch(manifestEntries.map((entry) => ({
    path: entry.path,
    separator: entry.originalSeparator ?? "",
    updatedFirstLine: entry.originalFirstLine,
    requireOriginalMatch: false
  })));
  return collectWindowsRestoreFailures(stdout, manifestEntries);
}

export async function restoreSessionChanges(manifestEntries) {
  if (!manifestEntries.length) {
    return;
  }

  const failures = process.platform === "win32"
    ? await restoreSessionChangesWindows(manifestEntries)
    : await restoreSessionChangesPosix(manifestEntries);

  if (failures.length > 0) {
    const details = failures
      .map((failure) => `${failure.path}: ${failure.message}`)
      .join("; ");
    throw new Error(`Failed to restore ${failures.length} rollout file(s): ${details}`);
  }
}

export function summarizeProviderCounts(providerCounts) {
  const result = {};
  for (const [scope, counts] of Object.entries(providerCounts)) {
    result[scope] = Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
  return result;
}
