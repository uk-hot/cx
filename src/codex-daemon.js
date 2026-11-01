import { spawn } from "node:child_process";
import process from "node:process";

const DAEMON_COMMAND_TIMEOUT_MS = 30000;

// Runs `codex app-server daemon <command>` against this home and collects its
// output. A command that hangs is killed and reported with a null exit code.
function runDaemonCommand(codexHome, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "daemon", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
      // npm installs codex as a .cmd shim on Windows, which needs a shell.
      shell: process.platform === "win32"
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

// The daemon prints progress events as JSON lines before its final status line.
function lastStatus(output) {
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (typeof value?.status === "string") {
        return value.status;
      }
    } catch {
      // Not a JSON line (warnings, errors).
    }
  }
  return null;
}

function lastLine(output) {
  return output.trim().split(/\r?\n/).at(-1) ?? "";
}

// Codex sessions send their requests through a shared app-server daemon, which
// reads auth.json only when it starts. After the login changes it keeps using
// the previous account until it is restarted. A daemon that isn't running (or
// a Codex without one) needs nothing, so this never starts a new one.
export async function restartCodexDaemon(codexHome, { timeoutMs = DAEMON_COMMAND_TIMEOUT_MS } = {}) {
  let version;
  try {
    version = await runDaemonCommand(codexHome, "version", timeoutMs);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "not-running" };
    }
    throw error;
  }
  // A daemon that doesn't answer is still running, and likely stuck.
  if (version.code === null) {
    return { status: "failed", detail: "timed out checking the daemon" };
  }
  if (version.code !== 0 || lastStatus(version.output) !== "running") {
    return { status: "not-running" };
  }

  const restart = await runDaemonCommand(codexHome, "restart", timeoutMs);
  if (restart.code !== 0 || lastStatus(restart.output) !== "restarted") {
    return {
      status: "failed",
      detail: restart.code === null ? "timed out" : lastLine(restart.output) || `exit code ${restart.code}`
    };
  }
  return { status: "restarted" };
}
