import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReminderManager, REMINDER_PRIORITIES } from "../core/control/reminder-manager.mjs";
import { createJobManager } from "../core/control/job-manager.mjs";
import { createOperationJournal } from "../core/control/operation-journal.mjs";
import { inspectDatabase } from "../core/control/database-health.mjs";
import { createRotatingBackup } from "../core/control/backup-manager.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sqlitePath: path.join(root, "planner.sqlite") };
}

test("reminders honor pause except wakeup and require an id when acknowledgements are ambiguous", (t) => {
  const f = fixture(t);
  let now = new Date("2026-09-22T02:00:00Z");
  const manager = createReminderManager({ sqlitePath: f.sqlitePath, now: () => now });
  const first = manager.register({ sourcePlugin: "test", kind: "user", priority: REMINDER_PRIORITIES.user, content: "吃饭", requiresAck: true });
  const wakeup = manager.register({ sourcePlugin: "test", kind: "wakeup", priority: REMINDER_PRIORITIES.wakeup, content: "起床", requiresAck: true });
  manager.pause(30);
  assert.deepEqual(manager.claimDue().map((row) => row.shortId), [wakeup.reminder.shortId]);
  manager.finishDelivery(wakeup.reminder.id, { ok: true });
  manager.resume();
  assert.deepEqual(manager.claimDue().map((row) => row.shortId), [first.reminder.shortId]);
  manager.finishDelivery(first.reminder.id, { ok: true });
  assert.equal(manager.acknowledge("收到").status, "ambiguous");
  assert.equal(manager.acknowledge(`收到 ${first.reminder.shortId}`).status, "acknowledged");
});

test("managed jobs reject stale versions and recurring completion returns to desired", (t) => {
  const f = fixture(t);
  const jobs = createJobManager({ sqlitePath: f.sqlitePath });
  jobs.upsertDesired({ jobId: "test:daily", version: 1, owner: "test", kind: "daily", taskName: "MashiroBot Test", recurrence: { daily: true } });
  assert.equal(jobs.claim("test:daily", 2).claimed, false);
  assert.equal(jobs.claim("test:daily", 1).claimed, true);
  assert.equal(jobs.complete("test:daily", 1, { ok: true, recurring: true }).updated, true);
  assert.equal(jobs.get("test:daily").status, "desired");
});

test("managed jobs expire only past one-shot work that is still active", (t) => {
  const f = fixture(t);
  const now = new Date("2026-10-16T00:00:00Z");
  const jobs = createJobManager({ sqlitePath: f.sqlitePath, now: () => now });
  const add = (jobId, runAt, recurrence = null) => jobs.upsertDesired({
    jobId,
    version: 1,
    owner: "test",
    kind: "fixture",
    taskName: `OpenClaw-${jobId}`,
    runAt,
    recurrence,
  });

  add("past-desired", "2026-10-15T00:00:00Z");
  add("past-running", "2026-10-15T01:00:00Z");
  assert.equal(jobs.claim("past-running", 1).claimed, true);
  add("past-recurring", "2026-10-15T02:00:00Z", { calendar: "daily" });
  add("future", "2026-10-17T00:00:00Z");
  add("completed", "2026-10-15T03:00:00Z");
  assert.equal(jobs.claim("completed", 1).claimed, true);
  assert.equal(jobs.complete("completed", 1, { ok: true }).updated, true);
  add("cancelled", "2026-10-15T04:00:00Z");
  assert.equal(jobs.cancel("cancelled"), true);

  assert.equal(jobs.expirePastOneShot(), 2);
  for (const jobId of ["past-desired", "past-running"]) {
    assert.equal(jobs.get(jobId).status, "failed");
    assert.equal(jobs.get(jobId).error, "expired before task reconciliation");
    assert.equal(jobs.get(jobId).completedAt, now.toISOString());
  }
  assert.equal(jobs.get("past-recurring").status, "desired");
  assert.equal(jobs.get("future").status, "desired");
  assert.equal(jobs.get("completed").status, "completed");
  assert.equal(jobs.get("cancelled").status, "cancelled");
});

test("dispatch merges due low-priority reminders without claiming unrelated high-priority work", (t) => {
  const f = fixture(t);
  const manager = createReminderManager({ sqlitePath: f.sqlitePath });
  const high = manager.register({ sourcePlugin: "test", kind: "disk", priority: 5, content: "磁盘危险" }).reminder;
  const lowA = manager.register({ sourcePlugin: "test", kind: "habit", priority: 2, content: "洗澡" }).reminder;
  const lowB = manager.register({ sourcePlugin: "test", kind: "statistics", priority: 1, content: "日报" }).reminder;
  assert.deepEqual(manager.claimForDispatch(lowA.id).map((row) => row.id).sort(), [lowA.id, lowB.id].sort());
  assert.equal(manager.listCurrent().find((row) => row.id === high.id)?.status, "pending");
});

test("short reminder IDs are never reused after an earlier reminder is completed", (t) => {
  const f = fixture(t);
  const manager = createReminderManager({ sqlitePath: f.sqlitePath });
  const completed = manager.register({ shortId: "R123", sourcePlugin: "test", kind: "statistics", priority: 1, content: "old" }).reminder;
  manager.finishDelivery(completed.id, { ok: true });
  const originalRandom = Math.random;
  const values = [0.123, 0.124];
  Math.random = () => values.shift() ?? 0.125;
  t.after(() => { Math.random = originalRandom; });
  const next = manager.register({ sourcePlugin: "test", kind: "statistics", priority: 1, content: "new" }).reminder;
  assert.equal(next.shortId, "R124");
});

test("operation journal, migrations, health check, and rotating backup share one database", (t) => {
  const f = fixture(t);
  const journal = createOperationJournal(f.sqlitePath);
  const operation = journal.prepare({ owner: "test", kind: "move", targetKey: "game.exe" });
  journal.transition(operation.operationId, "applying");
  journal.transition(operation.operationId, "applied");
  const backup = createRotatingBackup({ sqlitePath: f.sqlitePath, backupRoot: path.join(f.root, "backups"), reason: "test" });
  assert.equal(backup.ok, true);
  const health = inspectDatabase(f.sqlitePath, { backupRoot: path.join(f.root, "backups") });
  assert.equal(health.ok, true);
  assert.equal(health.migrationVersion, "20260922-003-undo-journal");
  assert.ok(health.latestBackup);
});
