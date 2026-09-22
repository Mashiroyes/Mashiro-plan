import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUndoManager } from "../core/control/undo-manager.mjs";
import { classifyRisk, RISK_LEVELS } from "../core/control/risk-policy.mjs";
import { formatDiagnostics } from "../core/control/system-diagnostics.mjs";
import { collectCurrentTasks, formatCurrentTasks } from "../core/control/current-tasks.mjs";
import { openControlDatabase } from "../core/control/database.mjs";

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

test("current tasks aggregates available providers and marks unavailable ones", (t) => {
  const root = fixture(t); const sqlitePath = path.join(root, "db.sqlite"); const db = openControlDatabase(sqlitePath);
  db.exec("CREATE TABLE plan_items(title TEXT,start_time TEXT,end_time TEXT,item_status TEXT,plan_date TEXT); INSERT INTO plan_items VALUES('听力','10:00','11:00','active','2026-09-22');"); db.close();
  const sections = collectCurrentTasks({ sqlitePath, now: new Date("2026-09-22T04:00:00Z"), reminderManager: { listCurrent: () => [{ shortId: "R001", content: "会议" }] } });
  const text = formatCurrentTasks(sections); assert.match(text, /今天计划：10:00-11:00 听力/); assert.match(text, /活动提醒：R001 会议/); assert.match(text, /游戏计时：未核验/);
});
