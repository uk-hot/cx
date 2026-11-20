import { spawn } from "node:child_process";
import process from "node:process";

// Every process a Codex command starts must end with it when cx gives up on
// it. On POSIX the command is started in a process group of its own
// (`detached: DETACHED`), which is killed as a whole: the npm launcher may run
// the native binary as a child of its own, which a SIGKILL to the launcher
// leaves running. On Windows it runs under cmd.exe, and the whole tree is
// ended.

/** Pass as `detached` to spawn a command killTree can end with all it started. */
export const DETACHED = process.platform !== "win32";

/** @param {import("node:child_process").ChildProcess} child */
export function killTree(child) {
  if (!child.pid) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is gone.
  }
}
