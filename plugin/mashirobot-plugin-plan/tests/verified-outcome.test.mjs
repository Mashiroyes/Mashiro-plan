import test from "node:test";
import assert from "node:assert/strict";

import { handlePlan } from "../routes/plan.mjs";
import { handleWakeup } from "../routes/wakeup.mjs";

const now = new Date("2026-09-16T09:00:00+08:00");
const planText = "今日计划\n10:00 - 11:00 英语听力";
const saved = {
  planDate: "2026-09-16",
  revisionNo: 1,
  items: [{ startTime: "10:00", endTime: "11:00", title: "英语听力", deliveryMode: "schedule" }],
  scheduledTasks: [{ taskName: "OpenClaw-Plan-test" }],
  immediateItemIds: [],
  completedItemIds: [],
};

test("does not claim a complete plan save when task registration fails", async () => {
  const result = await handlePlan(planText, {
    now,
    planRuntime: { async runManagePlan() { return { ...saved, saved: true, verifiedDatabase: true, verifiedTasks: false, partialFailure: true, taskError: "registration denied" }; } },
  });
  assert.match(result.reply, /已保存/u);
  assert.match(result.reply, /提醒任务未确认/u);
  assert.doesNotMatch(result.reply, /已安排 \d+ 个一次性提醒/u);
});

test("task success without a verified database row is reported as unknown", async () => {
  const result = await handlePlan(planText, {
    now,
    planRuntime: { async runManagePlan() { return { ...saved, verifiedDatabase: false, verifiedTasks: true, partialFailure: true }; } },
  });
  assert.doesNotMatch(result.reply, /已保存 2026/u);
  assert.match(result.reply, /无法确认|核对/u);
});

test("awaits a late verified result before claiming success", async () => {
  let resolved = false;
  const result = await handlePlan(planText, {
    now,
    planRuntime: { async runManagePlan() { await new Promise((resolve) => setTimeout(resolve, 20)); resolved = true; return { ...saved, saved: true, verifiedDatabase: true, verifiedTasks: true, partialFailure: false }; } },
  });
  assert.equal(resolved, true);
  assert.match(result.reply, /已安排 1 个一次性提醒/u);
});

test("unknown wakeup mutation state tells the user to query instead of retrying", async () => {
  const result = await handleWakeup("明天早上7点叫我起床", {
    now,
    planRuntime: { async runRoutineAction() { return { operationId: "op-unknown" }; } },
  });
  assert.match(result.reply, /查询起床提醒/u);
  assert.match(result.reply, /不要立即重复/u);
  assert.doesNotMatch(result.reply, /^已设置/u);
});
