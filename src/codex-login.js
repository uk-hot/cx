import { spawn } from "node:child_process";
import process from "node:process";

const STOP_TIMEOUT_MS = 3000;

function ignoreInterrupt() {
  // Ctrl-C belongs to Codex; cx stays alive to finish or undo the add afterwards.
}

/**
 * Runs Codex interactively so the user can sign in, and waits for it to exit.
 * @param {string} codexHome
 */
export async function runCodexForLogin(codexHome) {
  let stopCodex = () => {};
  const onHangup = () => stopCodex();
  process.on("SIGINT", ignoreInterrupt);
  process.on("SIGHUP", onHangup);
  try {
    await new Promise((resolve, reject) => {
      // The shared daemon may still hold the removed account in memory, so run
      // without it and let Codex decide from the files in this home.
      const child = spawn("codex", ["--no-daemon"], {
        stdio: "inherit",
        env: { ...process.env, CODEX_HOME: codexHome },
        // npm installs codex as a .cmd shim on Windows, which needs a shell.
        shell: process.platform === "win32"
      });
      // Codex outlives a closed terminal, which would leave cx waiting forever
      // with auth.json still removed.
      stopCodex = () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS).unref();
      };
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT") {
      throw new Error("The codex command was not found. Install Codex, then run cx add again.");
    }
    throw error;
  } finally {
    process.off("SIGINT", ignoreInterrupt);
    process.off("SIGHUP", onHangup);
  }
}
