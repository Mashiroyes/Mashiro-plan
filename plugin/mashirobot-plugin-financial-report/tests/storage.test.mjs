import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createLearningStore } from "../core/storage.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "mashiro-finance-store-"));
  const path = join(directory, "test.sqlite");
  const store = createLearningStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize({ accountId: "wx", conversationId: "me", installedDate: "2026-08-09" });
  return store;
}

test("creates four prefixed tables and keeps an existing notes table", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mashiro-finance-migrate-"));
  const path = join(directory, "test.sqlite");
  const before = new DatabaseSync(path);
  before.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES ('keep me')");
  before.close();
  const store = createLearningStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize({ accountId: "wx", conversationId: "me", installedDate: "2026-08-09" });
  const tables = store._database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  for (const name of ["financial_report_course_state", "financial_report_deliveries", "financial_report_answers", "financial_report_feedback", "notes"]) {
    assert.ok(tables.includes(name), name);
  }
  assert.equal(store._database.prepare("SELECT body FROM notes").get().body, "keep me");
});

test("keeps course state separate and freezes both while paused", (t) => {
  const store = fixture(t);
  assert.equal(store.getCourseState("wx", "me", "financial_report").courseType, "financial_report");
  assert.equal(store.getCourseState("wx", "me", "prospectus").courseType, "prospectus");
  store.pauseCourses("wx", "me", "2026-08-11");
  assert.equal(store.getCourseState("wx", "me", "prospectus").paused, true);
  store.resumeCourses("wx", "me", "2026-08-15");
  assert.deepEqual(store.getCourseState("wx", "me", "financial_report").pauseIntervals,
    [{ startDate: "2026-08-11", endDate: "2026-08-14" }]);
});

test("claims one delivery idempotently and can reclaim a stale worker", (t) => {
  const store = fixture(t);
  const args = { accountId: "wx", conversationId: "me", courseType: "financial_report", lessonNumber: 1, scheduledDate: "2026-08-10" };
  const first = store.claimDelivery({ ...args, now: new Date("2026-08-10T04:20:00Z") });
  assert.equal(first.claimed, true);
  assert.equal(store.claimDelivery({ ...args, now: new Date("2026-08-10T04:25:00Z") }).reason, "busy");
  assert.equal(store.claimDelivery({ ...args, now: new Date("2026-08-10T04:31:00Z") }).reason, "reclaimed");
  store.finishDelivery(first.delivery.id, { success: true, now: new Date("2026-08-10T04:32:00Z") });
  assert.equal(store.claimDelivery({ ...args, now: new Date("2026-08-10T04:33:00Z") }).reason, "already_sent");
  assert.equal(store._database.prepare("SELECT COUNT(*) AS n FROM financial_report_deliveries").get().n, 1);
});

test("keeps repeated answer attempts and creates independent feedback", (t) => {
  const store = fixture(t);
  const base = { accountId: "wx", conversationId: "me", courseType: "financial_report", lessonNumber: 1 };
  store.saveAnswer({ ...base, answerText: "第一次" });
  store.saveAnswer({ ...base, answerText: "第二次" });
  assert.equal(store._database.prepare("SELECT COUNT(*) AS n FROM financial_report_answers").get().n, 2);
  assert.equal(store._database.prepare("SELECT COUNT(*) AS n FROM financial_report_feedback").get().n, 2);
});

test("claims, finishes and retries feedback", (t) => {
  const store = fixture(t);
  store.saveAnswer({ accountId: "wx", conversationId: "me", courseType: "prospectus", lessonNumber: 1, answerText: "答案" });
  const claimed = store.claimPendingFeedback({ now: new Date("2026-08-11T10:20:00Z") });
  assert.equal(claimed.status, "processing");
  store.failFeedback(claimed.id, "temporary");
  const retry = store.claimPendingFeedback({ now: new Date("2026-08-11T10:21:00Z") });
  const ready = store.finishFeedback(retry.id, "点评");
  assert.equal(ready.status, "ready");
  assert.equal(ready.output_text, "点评");
});

test("rolls back answer if paired feedback insert fails", (t) => {
  const store = fixture(t);
  store._database.exec(`
    CREATE TRIGGER reject_feedback BEFORE INSERT ON financial_report_feedback
    BEGIN SELECT RAISE(ABORT, 'forced feedback failure'); END;
  `);
  assert.throws(() => store.saveAnswer({
    accountId: "wx", conversationId: "me", courseType: "financial_report", lessonNumber: 1, answerText: "不能半写入",
  }), /forced feedback failure/);
  assert.equal(store._database.prepare("SELECT COUNT(*) AS n FROM financial_report_answers").get().n, 0);
  assert.equal(store.integrityCheck(), "ok");
});
