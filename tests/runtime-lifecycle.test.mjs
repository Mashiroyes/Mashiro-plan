import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMashiroBotRuntime } from "../core/runtime/mashirobot-runtime.mjs";

function fixture(t) {
  const planRoot = mkdtempSync(path.join(os.tmpdir(), "mashiro-runtime-"));
  mkdirSync(path.join(planRoot, "plugin"), { recursive: true });
  mkdirSync(path.join(planRoot, "sqlite"), { recursive: true });
  copyFileSync(path.join(process.cwd(), "commands.yaml"), path.join(planRoot, "commands.yaml"));
  t.after(() => rmSync(planRoot, { recursive: true, force: true }));
  return planRoot;
}

function emptyRegistry(failures = []) {
  return { plugins: [], byMenuIndex: new Map(), byExactCommand: new Map(), failures };
}

test("creates one ready runtime with an unmatched compatibility result", async (t) => {
  const planRoot = fixture(t);
  const runtime = await createMashiroBotRuntime({
    planRoot,
    createRotatingBackup: () => {},
    loadPlugins: async () => emptyRegistry(),
    reconcileWindowsTasks: async () => ({ ok: true, missing: [], drifted: [], orphaned: [], failed: [] }),
    logger: () => {},
  });
  assert.equal(runtime.getStatus().state, "ready");
  assert.equal(await runtime.handleMessage("ordinary chat", { accountId: "a", conversationId: "c" }), null);
  const first = runtime.shutdown();
  const second = runtime.shutdown();
  assert.equal(first, second);
  assert.deepEqual(await first, { ok: true, failures: [] });
});

test("plugin or reconciliation problems degrade without blocking routing", async (t) => {
  const planRoot = fixture(t);
  const runtime = await createMashiroBotRuntime({
    planRoot,
    createRotatingBackup: () => {},
    loadPlugins: async () => emptyRegistry([{ code: "fixture" }]),
    reconcileWindowsTasks: async () => ({ ok: false, missing: ["x"], drifted: [], orphaned: [], failed: [] }),
    logger: () => {},
  });
  assert.equal(runtime.getStatus().state, "degraded");
  assert.equal(await runtime.handleMessage("ordinary chat", { accountId: "a", conversationId: "c" }), null);
});

test("database startup failure rejects runtime creation", async (t) => {
  const planRoot = fixture(t);
  await assert.rejects(createMashiroBotRuntime({
    planRoot,
    createRotatingBackup: () => {},
    migrateControlDatabase: () => { throw new Error("migration failed"); },
    logger: () => {},
  }), /migration failed/);
});
