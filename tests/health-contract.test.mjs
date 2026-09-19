import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPluginHealth,
  evaluateAdapterImportHealth,
  evaluateHeartbeatHealth,
  evaluateRegisteredTaskHealth,
  runPlanHealthChecks,
} from "../plugin/mashirobot-plugin-plan/health.mjs";

const now = "2026-09-16T05:00:00.000Z";

test("a registered task without a fresh status is not verified", () => {
  const missing = evaluateRegisteredTaskHealth({ registered: true, now });
  assert.equal(missing.ok, false);
  assert.equal(missing.level, "heartbeat");

  const fresh = evaluateRegisteredTaskHealth({
    registered: true,
    statusCheckedAt: "2026-09-16T04:58:00.000Z",
    statusOk: true,
    now,
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.level, "verified");
});

test("an old heartbeat is unhealthy", () => {
  const result = evaluateHeartbeatHealth({
    heartbeatAt: "2026-09-16T04:30:00.000Z",
    now,
    maxAgeMs: 10 * 60_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.level, "heartbeat");
  assert.equal(result.evidence.ageMs, 30 * 60_000);
});

test("a current workspace adapter import is verified", () => {
  const result = evaluateAdapterImportHealth({
    imported: true,
    modulePath: "C:/Users/test/.openclaw/workspace/fast-routine.js",
    now,
  });
  assert.equal(result.ok, true);
  assert.equal(result.level, "verified");
  assert.equal(result.evidence.imported, true);
});

test("plugin health promises are awaited", async () => {
  let resolved = false;
  const health = await collectPluginHealth({
    plugins: [{
      manifest: { id: "async-plugin" },
      module: {
        healthCheck: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          resolved = true;
          return { ok: true };
        },
      },
    }],
  });
  assert.equal(resolved, true);
  assert.deepEqual(health, { "async-plugin": { ok: true } });
});

test("plan file checks expose the common health contract", () => {
  const result = runPlanHealthChecks({
    exists: () => true,
    now: () => new Date(now).getTime(),
    runPython: (command, args) => {
      assert.equal(command, "python");
      assert.deepEqual(args, ["-c", "from PIL import Image; print(Image.__version__)"]);
      return { status: 0, stdout: "12.1.1\n" };
    },
  });
  assert.equal(result.ok, true);
  for (const [name, entry] of Object.entries(result.checks)) {
    assert.deepEqual(Object.keys(entry), ["ok", "level", "evidence", "checkedAt"]);
    assert.equal(entry.level, name === "python" ? "verified" : "file");
    assert.equal(entry.checkedAt, now);
  }
});
