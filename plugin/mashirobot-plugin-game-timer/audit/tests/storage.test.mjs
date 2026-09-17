import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditStore } from "../core/audit-storage.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-audit-"));
  return { root, sqlitePath: path.join(root, "planner.sqlite") };
}

const qqTarget = {
  key: "qq",
  displayName: "QQ",
  kind: "software",
  executablePath: "C:\\Program Files\\Tencent\\QQNT\\QQ.exe",
};

test("audit sums foreground seconds and ignores batch replay", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createAuditStore(sqlitePath);
    store.replaceTargets([qqTarget]);
    const batch = [{
      targetKey: "qq",
      displayName: "QQ",
      executablePath: qqTarget.executablePath,
      startedAt: "2026-09-15T01:00:00Z",
      endedAt: "2026-09-15T01:02:05Z",
      durationSeconds: 125,
      closeReason: "foreground-changed",
    }];
    assert.equal(store.appendBatch(batch).inserted, 1);
    assert.equal(store.appendBatch(batch).inserted, 0);
    assert.equal(store.summary({ from: "2026-09-15", to: "2026-09-15" }).totals.qq, 125);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("interval crossing Shanghai midnight is split between calendar days", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createAuditStore(sqlitePath);
    store.replaceTargets([qqTarget]);
    store.appendBatch([{
      targetKey: "qq",
      displayName: "QQ",
      executablePath: qqTarget.executablePath,
      startedAt: "2026-09-15T15:59:30Z",
      endedAt: "2026-09-15T16:00:30Z",
      durationSeconds: 60,
      closeReason: "foreground-changed",
    }]);
    assert.equal(store.summary({ from: "2026-09-15", to: "2026-09-15" }).totals.qq, 30);
    assert.equal(store.summary({ from: "2026-09-16", to: "2026-09-16" }).totals.qq, 30);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat health becomes stale and stale open interval closes without offline time", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createAuditStore(sqlitePath);
    store.replaceTargets([qqTarget]);
    store.heartbeat({
      workerId: "interactive",
      observedAt: "2026-09-15T01:01:00Z",
      currentTargetKey: "qq",
      currentExecutablePath: qqTarget.executablePath,
      currentIntervalStartedAt: "2026-09-15T01:00:00Z",
    });
    assert.equal(store.workerHealth(new Date("2026-09-15T01:02:00Z")).fresh, true);
    assert.equal(store.workerHealth(new Date("2026-09-15T01:04:01Z")).fresh, false);
    assert.equal(store.closeStaleInterval("interactive").inserted, 1);
    assert.equal(store.summary({ from: "2026-09-15", to: "2026-09-15" }).totals.qq, 60);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("old detailed intervals aggregate by day before deletion", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createAuditStore(sqlitePath);
    store.replaceTargets([qqTarget]);
    store.appendBatch([{
      targetKey: "qq", displayName: "QQ", executablePath: qqTarget.executablePath,
      startedAt: "2026-01-01T01:00:00Z", endedAt: "2026-01-01T01:01:00Z",
      durationSeconds: 60, closeReason: "foreground-changed",
    }]);
    const result = store.aggregateBefore(new Date("2026-04-02T00:00:00Z"));
    assert.equal(result.deleted, 1);
    assert.equal(store.summary({ from: "2026-01-01", to: "2026-01-01" }).totals.qq, 60);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
