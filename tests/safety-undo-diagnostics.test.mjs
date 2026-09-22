import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUndoManager } from "../core/control/undo-manager.mjs";
import { classifyRisk, RISK_LEVELS } from "../core/control/risk-policy.mjs";
import { formatDiagnostics } from "../core/control/system-diagnostics.mjs";
import { collectCurrentTasks, formatCurrentTasks } from "../core/control/current-tasks.mjs";
import { createSystemCommandRouter } from "../core/control/system-command-router.mjs";

function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashiro-safety-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test("undo is scoped, single-use, and failed inverses remain retryable", async (t) => {
  const root = fixture(t); let calls = 0; const manager = createUndoManager({ sqlitePath: path.join(root, "db.sqlite"), handlers: { sample: async () => { calls += 1; if (calls === 1) throw new Error("token=leak"); } } });
  manager.record({ scope: "a:c", owner: "test", actionKind: "sample", description: "测试", inversePayload: { id: 1 } });
  assert.equal((await manager.undoLatest("other")).status, "none"); assert.equal((await manager.undoLatest("a:c")).status, "failed"); assert.equal((await manager.undoLatest("a:c")).status, "undone"); assert.equal((await manager.undoLatest("a:c")).status, "none");
});

test("risk policy separates direct, undoable, and confirm", () => {
  assert.equal(classifyRisk({}), RISK_LEVELS.LOW); assert.equal(classifyRisk({ reversible: true }), RISK_LEVELS.MEDIUM); assert.equal(classifyRisk({ permanent: true }), RISK_LEVELS.HIGH);
});

test("diagnostic formatter distinguishes failed and unknown", () => {
  const text = formatDiagnostics([{ name: "A", status: "ok", detail: "正常" }, { name: "B", status: "unknown", detail: "未读", repair: "检查" }, { name: "C", status: "failed", detail: "坏", repair: "修复" }]);
  assert.match(text, /正常｜A/); assert.match(text, /未核验｜B/); assert.match(text, /异常｜C.*修复/);
});

test("current tasks combines shared reminders with plugin-owned sections", async () => {
  const sections = await collectCurrentTasks({ reminderManager: { listCurrent: () => [{ shortId: "R001", content: "会议" }] }, pluginSections: [{ title: "今天计划", status: "ok", items: ["10:00-11:00 听力"] }, { title: "游戏计时", status: "unknown", items: [] }] });
  const text = formatCurrentTasks(sections); assert.match(text, /今天计划：10:00-11:00 听力/); assert.match(text, /活动提醒：R001 会议/); assert.match(text, /游戏计时：未核验/);
});

test("acknowledgement reports deferred Windows task cleanup", async () => {
  const route = createSystemCommandRouter({
    reminderManager: {
      acknowledge: () => ({
        status: "acknowledged",
        reminder: { shortId: "R123", sourcePlugin: "mashirobot-plugin-plan" },
      }),
    },
    onAcknowledge: async () => ({ cleanupPending: true }),
  });

  const result = await route("收到");

  assert.equal(result.handled, true);
  assert.match(result.reply, /已确认 R123/);
  assert.match(result.reply, /任务尚未清理/);
});
