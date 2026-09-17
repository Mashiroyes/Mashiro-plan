import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlockSyncer } from "../core/syncer.mjs";

test("waits for and verifies a fresh successful worker state", async () => {
  const states = [
    { LastSync: { ok: true, completedAt: "2026-08-07T00:00:00.000Z" } },
    { LastSync: { ok: true, completedAt: "2026-08-07T00:00:01.000Z", ruleCount: 1 } },
  ];
  const result = await createBlockSyncer({
    runLocalProcess: async () => ({ exitCode: 0 }),
    readState: async () => states.shift() ?? states.at(-1),
    sleep: async () => {},
    now: (() => { const values = [Date.parse("2026-08-07T00:00:00.500Z"), Date.parse("2026-08-07T00:00:00.500Z")]; return () => values.shift() ?? Date.parse("2026-08-07T00:00:00.500Z"); })(),
  }).apply();
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.sync.ruleCount, 1);
});

test("reports a missing scheduled worker immediately", async () => {
  const syncer = createBlockSyncer({ readState: async () => ({}), runLocalProcess: async () => { throw new Error("missing"); } });
  await assert.rejects(syncer.apply(), /系统同步任务未运行/u);
});

test("reports a fresh worker failure instead of timing out", async () => {
  const states = [
    { LastSync: { ok: true, completedAt: "2026-08-07T00:00:00.000Z" } },
    { LastSync: { ok: false, completedAt: "2026-08-07T00:00:01.000Z", error: "registry denied" } },
  ];
  const syncer = createBlockSyncer({
    runLocalProcess: async () => ({ exitCode: 0 }), readState: async () => states.shift(), sleep: async () => {},
    now: () => Date.parse("2026-08-07T00:00:00.500Z"),
  });
  await assert.rejects(syncer.apply(), /registry denied/u);
});
