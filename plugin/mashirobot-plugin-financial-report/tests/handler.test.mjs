import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseLearningCommand } from "../core/parser.mjs";
import { loadCurriculum } from "../core/curriculum.mjs";
import { createLearningStore } from "../core/storage.mjs";
import { handleLearningCommand } from "../core/handler.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const curriculum = loadCurriculum(pluginRoot);

function fixture(t, now = new Date("2026-08-11T10:20:00Z")) {
  const directory = mkdtempSync(join(tmpdir(), "mashiro-handler-"));
  const store = createLearningStore(join(directory, "db.sqlite"));
  store.initialize({ accountId: "wx", conversationId: "me", installedDate: "2026-08-09" });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const context = { accountId: "wx", conversationId: "me", now };
  const run = (message, extra = {}) => handleLearningCommand(parseLearningCommand(message), context,
    { store, curriculum, now, wakeFeedbackTask: () => {}, ...extra });
  return { store, run, context, now };
}

test("status and manual course views do not create delivery rows", (t) => {
  const { store, run } = fixture(t);
  assert.match(run("财报课程").reply, /已发送：0\/30/);
  assert.match(run("今日财报").reply, /第 2 天财报课/);
  assert.match(run("补学第1天").reply, /第 1 天财报课/);
  assert.match(run("今日招股书").reply, /第 1 课招股书课/);
  assert.match(run("补学招股书第1课").reply, /第 1 课招股书课/);
  assert.equal(store._database.prepare("SELECT COUNT(*) AS n FROM financial_report_deliveries").get().n, 0);
});

test("pause and resume freeze both course types", (t) => {
  const { store, run } = fixture(t);
  run("暂停财报");
  assert.equal(store.getCourseState("wx", "me", "financial_report").paused, true);
  assert.equal(store.getCourseState("wx", "me", "prospectus").paused, true);
  run("继续财报");
  assert.equal(store.getCourseState("wx", "me", "financial_report").paused, false);
});

test("implicit answer requires exactly one unanswered sent lesson", (t) => {
  const { store, run } = fixture(t);
  assert.match(run("财报答案 我的回答").reply, /无法唯一判断/);
  const claim = store.claimDelivery({ accountId: "wx", conversationId: "me", courseType: "financial_report", lessonNumber: 2, scheduledDate: "2026-08-11" });
  store.finishDelivery(claim.delivery.id, { success: true });
  assert.match(run("财报答案 我的回答").reply, /第 2 天财报答案.*聊天模式/s);
});

test("explicit and repeated answers create separate pending attempts", (t) => {
  const { store, run } = fixture(t);
  run("财报答案 第1天 第一次");
  run("财报答案 第1天 第二次");
  run("招股书答案 第1课 我的答案");
  assert.equal(store._database.prepare("SELECT COUNT(*) AS n FROM financial_report_answers").get().n, 3);
  assert.equal(store._database.prepare("SELECT COUNT(*) AS n FROM financial_report_feedback WHERE status='pending'").get().n, 3);
});

test("wake failure keeps the answer pending and reports a warning", (t) => {
  const { store, run } = fixture(t);
  const response = run("财报答案 第1天 内容", { wakeFeedbackTask: () => { throw new Error("任务不可用"); } });
  assert.match(response.reply, /答案已安全保存.*任务不可用/s);
  assert.equal(store._database.prepare("SELECT status FROM financial_report_feedback").get().status, "pending");
});

test("relearn does not alter automatic delivery success", (t) => {
  const { store, run } = fixture(t);
  const claim = store.claimDelivery({ accountId: "wx", conversationId: "me", courseType: "financial_report", lessonNumber: 2, scheduledDate: "2026-08-11" });
  store.finishDelivery(claim.delivery.id, { success: true });
  assert.match(run("重学今日财报").reply, /第 2 天财报课/);
  assert.equal(store._database.prepare("SELECT status FROM financial_report_deliveries").get().status, "sent");
});
