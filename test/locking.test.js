import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCK_BUSY_CODE, acquireLock } from "../src/locking.js";

async function makeHome(t) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "cx-lock-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  return codexHome;
}

test("a held lock is reported as busy", async (t) => {
  const codexHome = await makeHome(t);
  const release = await acquireLock(codexHome, "first");
  await assert.rejects(acquireLock(codexHome, "second"), (error) => error.code === LOCK_BUSY_CODE);
  await release();
  await (await acquireLock(codexHome, "third"))();
});

test("an old lock without an owner file is recovered", async (t) => {
  const codexHome = await makeHome(t);
  const lockDir = path.join(codexHome, "tmp", "provider-sync.lock");
  await fs.mkdir(lockDir, { recursive: true });

  // Freshly created: another run may still be about to write owner.json.
  await assert.rejects(acquireLock(codexHome), (error) => error.code === LOCK_BUSY_CODE);

  const past = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(lockDir, past, past);
  await (await acquireLock(codexHome))();
});
