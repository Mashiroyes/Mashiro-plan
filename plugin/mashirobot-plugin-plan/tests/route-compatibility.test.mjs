import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { createPluginRouter } from "../../../core/router/plugin-router.mjs";
import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { getHelp, handle, healthCheck, match } from "../index.mjs";
import { parseGeneralReminder } from "../routes/reminder.mjs";
import {
  normalizePlanInput,
  parsePlanDate,
  parsePlanItems,
} from "../routes/plan.mjs";
import { splitPlanAndDailyRecord } from "../routes/record.mjs";
import { parseWakeRequest } from "../routes/wakeup.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const PLAN_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const OLD_FAST_ROUTINE = path.join(
  os.homedir(),
  ".openclaw",
  "npm",
  "projects",
  "tencent-weixin-openclaw-weixin-7783ac86ba",
  "node_modules",
  "@tencent-weixin",
  "openclaw-weixin",
  "dist",
  "src",
  "messaging",
  "fast-routine.js",
);

function hasIndependentLegacyRouter() {
  if (!existsSync(OLD_FAST_ROUTINE)) return false;
  const source = readFileSync(OLD_FAST_ROUTINE, "utf8");
  return !source.includes("handleMashiroBotMessage as handleFastRoutineCommand");
}

function payloadBase64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function createFixture(t, now = new Date("2026-08-03T09:00:00+08:00")) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mashirobot-plan-route-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sqlitePath = path.join(root, "planner.sqlite");
  const removedTasks = [];
  const baseContext = {
    accountId: "account-test",
    conversationId: "conversation-test",
    now,
    planRoot: PLAN_ROOT,
    sqlitePath,
    tempRoot: path.join(root, "temp"),
    renderPluginHelp: (_pluginId, { detailed }) => ({
      handled: true,
      command: detailed ? "插件详细帮助" : "插件帮助",
      reply: detailed ? "DETAIL" : "SUMMARY",
      mediaPaths: [],
    }),
  };
  const baseRuntime = createPlanRuntime(baseContext);
  const routineActions = [];
  const planRuntime = {
    ...baseRuntime,
    async runManagePlan(action, args = {}) {
      assert.equal(action, "SavePlan");
      const result = await baseRuntime.runPlanner([
        "save-plan",
        "--payload-base64",
        args.PayloadBase64,
      ]);
      return {
        ...result,
        scheduledTasks: result.items
          .filter((item) => item.deliveryMode === "schedule")
          .map((item) => ({ taskName: item.taskName })),
        immediateItemIds: result.items
          .filter((item) => item.deliveryMode === "immediate")
          .map((item) => item.id),
        completedItemIds: result.items
          .filter((item) => item.deliveryMode === "skip")
          .map((item) => item.id),
        saved: true,
        verifiedDatabase: true,
        verifiedTasks: true,
        partialFailure: false,
      };
    },
    async runRoutineAction(action, args = {}) {
      routineActions.push({ action, args });
      if (action === "SetGeneralReminder") {
        const reminder = await baseRuntime.runPlanner([
          "create-general-reminder",
          "--payload-base64",
          payloadBase64({ content: args.Message, scheduledAt: args.StartAt }),
        ]);
        return { ...reminder, message: "通用提醒已设置。", verifiedDatabase: true, verifiedTasks: true, partialFailure: false };
      }
      if (action === "SetWakeup") {
        await baseRuntime.runPlanner([
          "set-plugin-state",
          "--plugin-id",
          "mashirobot-plugin-plan",
          "--state-key",
          "wakeup:active",
          "--payload-base64",
          payloadBase64({
            active: true,
            startAt: args.StartAt,
            windowsTaskName: "OpenClaw-Wakeup-fixture",
          }),
        ]);
        return { message: `已设置 ${args.StartAt.slice(0, 16).replace("T", " ")} 的起床提醒。`, verifiedDatabase: true, verifiedTasks: true, partialFailure: false };
      }
      if (action === "GetWakeup") return { message: "当前起床提醒：2026-08-04 07:00。", verifiedDatabase: true, verifiedTasks: true };
      if (action === "CancelWakeup") {
        await baseRuntime.runPlanner([
          "set-plugin-state",
          "--plugin-id",
          "mashirobot-plugin-plan",
          "--state-key",
          "wakeup:active",
          "--payload-base64",
          payloadBase64({ active: false }),
        ]);
        return { message: "已取消起床提醒。", verifiedDatabase: true, verifiedTasks: true, partialFailure: false };
      }
      throw new Error(`unexpected routine action: ${action}`);
    },
    async removeScheduledTask(taskName) {
      removedTasks.push(taskName);
      return true;
    },
  };
  const context = { ...baseContext, planRuntime };
  await baseRuntime.runPlanner(["init"]);
  return { baseRuntime, context, planRuntime, removedTasks, root, routineActions, sqlitePath };
}

function pluginRecord() {
  return {
    manifest: {
      id: "mashirobot-plugin-plan",
      name: "计划",
      description: "计划、记录、作息与提醒",
      menuIndex: 1,
      priority: 100,
      exactCommands: ["/计划", "/计划详细"],
    },
    module: { match, handle, healthCheck, getHelp },
  };
}

test("exports the async plugin contract and four help groups", () => {
  for (const exported of [match, handle, healthCheck, getHelp]) {
    assert.equal(typeof exported, "function");
  }
  assert.equal(handle.constructor.name, "AsyncFunction");
  const help = getHelp();
  assert.equal(help.groups.length, 4);
  assert.ok(help.detailedGroups.length >= help.groups.length);
  assert.match(help.fallbackText, /\/计划详细/);
  const helpText = JSON.stringify(help);
  for (const forbidden of ["喝水", "英语日志", "已喝水", "已写日志"]) {
    assert.doesNotMatch(helpText, new RegExp(forbidden));
  }
});

test("renders /计划 and /计划详细 through the core help service", async (t) => {
  const fixture = await createFixture(t);
  assert.deepEqual(await handle("/计划", fixture.context), {
    handled: true,
    command: "插件帮助",
    reply: "SUMMARY",
    mediaPaths: [],
  });
  assert.deepEqual(await handle("/计划详细", fixture.context), {
    handled: true,
    command: "插件详细帮助",
    reply: "DETAIL",
    mediaPaths: [],
  });
});

test("saves a combined plan and daily record into only the temporary database", async (t) => {
  const fixture = await createFixture(t);
  const text = [
    "今日计划",
    "14:00 - 15:00 背单词",
    "今日记录",
    "学习：1h",
    "娱乐：2h",
    "其他：",
    "chatgpt：3h",
    "英文小说：100字",
  ].join("\n");

  assert.equal(match(text, fixture.context), true);
  const result = await handle(text, fixture.context);

  assert.equal(result.handled, true);
  assert.equal(result.command, "保存计划和今日记录");
  const db = new DatabaseSync(fixture.sqlitePath);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) count FROM plan_revisions").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM daily_records").get().count, 1);
    const row = db
      .prepare("SELECT study_minutes,entertainment_minutes,other_json,reading_words FROM daily_records")
      .get();
    assert.equal(row.study_minutes, 60);
    assert.equal(row.entertainment_minutes, 120);
    assert.equal(JSON.parse(row.other_json)[0].minutes, 180);
    assert.equal(row.reading_words, 100);
  } finally {
    db.close();
  }
});

test("filters standalone Plan period headings before persistence and reminders", async (t) => {
  const fixture = await createFixture(t, new Date("2026-08-10T11:00:00+08:00"));
  assert.equal(
    normalizePlanInput(["凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上", "夜间", "夜里"].join("\n")),
    "",
  );
  const text = [
    "今日计划",
    "上午",
    "11:00 - 12:00 哈利波特",
    "下午",
    "12:00 - 17:00 chatgpt",
    "傍晚",
    "18:00 - 18:50 下午复盘",
    "晚上",
    "20:00 - 22:00 哈利波特",
    "夜间",
  ].join("\n");

  assert.equal(
    normalizePlanInput(text),
    [
      "今日计划",
      "11:00 - 12:00 哈利波特",
      "12:00 - 17:00 chatgpt",
      "18:00 - 18:50 下午复盘",
      "20:00 - 22:00 哈利波特",
    ].join("\n"),
  );
  assert.deepEqual(
    parsePlanItems(text).map((item) => item.title),
    ["哈利波特", "chatgpt", "下午复盘", "哈利波特"],
  );

  const result = await handle(text, fixture.context);
  assert.equal(result.command, "保存计划");

  const db = new DatabaseSync(fixture.sqlitePath);
  try {
    const revision = db.prepare("SELECT raw_text FROM plan_revisions").get();
    assert.ok(!/^(?:上午|下午|傍晚|晚上|夜间)$/m.test(revision.raw_text));
    assert.match(revision.raw_text, /18:00 - 18:50 下午复盘/);
    const titles = db
      .prepare("SELECT title FROM plan_items ORDER BY start_time")
      .all()
      .map((row) => row.title);
    assert.deepEqual(titles, ["哈利波特", "chatgpt", "下午复盘", "哈利波特"]);
  } finally {
    db.close();
  }
});

test("uses the explicit plan date for both sections of a combined message", async (t) => {
  const fixture = await createFixture(t, new Date("2026-08-04T10:27:00+08:00"));
  const text = [
    "8月3日计划",
    "00:00 - 03:00 chatgpt",
    "今日记录",
    "学习：3h",
    "英文小说：哈利波特 37926字",
  ].join("\n");

  assert.equal(match(text, fixture.context), true);
  assert.equal((await handle(text, fixture.context)).command, "保存计划和今日记录");

  const db = new DatabaseSync(fixture.sqlitePath);
  try {
    const planDates = db.prepare("SELECT DISTINCT plan_date FROM plan_revisions").all();
    assert.deepEqual(planDates.map((row) => row.plan_date), ["2026-08-03"]);
    const record = db
      .prepare("SELECT record_date,study_minutes,reading_title,reading_words FROM daily_records")
      .get();
    assert.equal(record.record_date, "2026-08-03");
    assert.equal(record.study_minutes, 180);
    assert.equal(record.reading_title, "哈利波特");
    assert.equal(record.reading_words, 37926);
  } finally {
    db.close();
  }
});

test("splits combined messages with all supported explicit plan date headers", () => {
  for (const header of ["2026-08-03计划", "2026年8月3日的计划", "8月3日计划"]) {
    const sections = splitPlanAndDailyRecord(`${header}\n09:00 - 10:00 背单词\n今日记录\n学习：1h`);
    assert.ok(sections, header);
    assert.equal(sections.planText.startsWith(header), true, header);
    assert.equal(sections.recordText.startsWith("今日记录"), true, header);
  }
});

test("covers plan and day/week/month/year record queries locally", async (t) => {
  const fixture = await createFixture(t);
  await handle("今日计划\n14:00 - 15:00 背单词", fixture.context);
  await handle("今日计划\n15:00 - 16:00 哈利波特", fixture.context);
  await handle("今日记录\n学习：1h\n娱乐：30分\n英文小说：200字", fixture.context);

  for (const [message, command] of [
    ["今天计划", "查询计划"],
    ["今天记录", "查询单日记录"],
    ["本周记录", "查询范围记录"],
    ["本月记录", "查询范围记录"],
    ["今年记录", "查询范围记录"],
  ]) {
    assert.equal(match(message, fixture.context), true, message);
    const result = await handle(message, fixture.context);
    assert.equal(result.command, command, message);
    if (message === "今天计划") assert.match(result.reply, /第 2 版/);
    for (const mediaPath of result.mediaPaths ?? []) {
      assert.equal(existsSync(mediaPath), true);
      rmSync(mediaPath, { force: true });
    }
  }
});

test("keeps exact completion keywords and SQLite runtime state before GPT", async (t) => {
  const fixture = await createFixture(t, new Date("2026-08-03T02:10:18+08:00"));
  for (const message of ["没打卡", "已打卡", "已睡觉"]) {
    assert.equal(match(message, fixture.context), true, message);
    assert.equal((await handle(message, fixture.context)).handled, true, message);
  }
  for (const message of ["已喝水", "已写日志"]) {
    assert.equal(match(message, fixture.context), false, message);
  }
  await fixture.baseRuntime.runPlanner([
    "set-plugin-state",
    "--plugin-id",
    "mashirobot-plugin-plan",
    "--state-key",
    "wakeup:active",
    "--payload-base64",
    payloadBase64({ active: true, windowsTaskName: "OpenClaw-Wakeup-fixture" }),
  ]);
  assert.equal((await handle("已起床", fixture.context)).command, "已起床");

  const db = new DatabaseSync(fixture.sqlitePath);
  try {
    assert.equal(db.prepare("SELECT routine_date FROM sleep_events").get().routine_date, "2026-08-02");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM habit_events").get().count, 0);
    const night = db
      .prepare("SELECT value_json FROM plugin_runtime_state WHERE state_key='night:2026-08-02'")
      .get();
    assert.equal(JSON.parse(night.value_json).slept, true);
    const wake = db
      .prepare("SELECT value_json FROM plugin_runtime_state WHERE state_key='wakeup:active'")
      .get();
    assert.equal(JSON.parse(wake.value_json).active, false);
  } finally {
    db.close();
  }
});

test("supports bare sleep ranges, reminder acknowledgement, and reminder parsing", async (t) => {
  const fixture = await createFixture(t, new Date("2099-08-03T09:00:00+08:00"));
  await fixture.baseRuntime.runPlanner([
    "record-sleep",
    "--date",
    "2026-08-02",
    "--slept-at",
    "2026-08-03T02:10:00+08:00",
  ]);
  const sleep = await handle("上个星期睡觉时间", fixture.context);
  assert.equal(sleep.command, "查询睡觉时间");

  const reminder = await handle("提醒我明天12点有个会议", fixture.context);
  assert.equal(reminder.command, "设置通用提醒");
  assert.match(reminder.reply, /每 5 分钟/);

  const timeFirstReminder = await handle("11:57提醒我吃饭", fixture.context);
  assert.equal(timeFirstReminder.command, "设置通用提醒");
  assert.match(timeFirstReminder.reply, /11:57 提醒你吃饭/);

  const db = new DatabaseSync(fixture.sqlitePath);
  try {
    db.prepare(
      `UPDATE general_reminders SET last_sent_at='2026-08-03T11:00:00+08:00' WHERE content='有个会议'`,
    ).run();
  } finally {
    db.close();
  }
  const acknowledged = await handle("收到", fixture.context);
  assert.equal(acknowledged.reply, "收到，已停止“有个会议”的后续提醒。");
  assert.equal(fixture.removedTasks.length, 1);

  const parsed = parseGeneralReminder(
    "提醒我2026年8月5日下午3点开会",
    new Date("2026-08-03T09:00:00+08:00"),
  );
  assert.deepEqual(parsed, { content: "开会", startAt: "2026-08-05T15:00:00+08:00" });
  assert.deepEqual(
    parseGeneralReminder("11:57提醒我吃饭", new Date("2026-08-03T09:00:00+08:00")),
    { content: "吃饭", startAt: "2026-08-03T11:57:00+08:00" },
  );
});

test("does not locally match removed explicit sleep-time commands", async (t) => {
  const fixture = await createFixture(t);
  for (const message of [
    "8月3日睡觉时间 2:04",
    "修改8月3日睡觉时间为 2:04",
    "删除8月3日睡觉时间",
  ]) {
    assert.equal(match(message, fixture.context), false, message);
  }
});

test("supports wakeup creation, query, cancel, and errors without Windows side effects", async (t) => {
  const fixture = await createFixture(t);
  for (const [message, command] of [
    ["明天早上7点叫我起床", "设置起床提醒"],
    ["查询起床提醒", "查询起床提醒"],
    ["取消起床提醒", "取消起床提醒"],
  ]) {
    assert.equal(match(message, fixture.context), true, message);
    assert.equal((await handle(message, fixture.context)).command, command, message);
  }
  assert.equal(
    parseWakeRequest("今天早上8点叫我起床", new Date("2026-08-03T09:00:00+08:00")).kind,
    "error",
  );
});

test("uses explicit plan and wakeup dates before relative defaults", () => {
  const now = new Date("2026-08-04T10:27:00+08:00");
  const combined = [
    "8月3日计划",
    "00:00 - 03:00 chatgpt",
    "今日记录",
    "学习：3h",
  ].join("\n");

  assert.equal(parsePlanDate(combined, now), "2026-08-03");
  assert.equal(parseWakeRequest("8月5日9点提醒我起床", now).startAt, "2026-08-05T09:00:00+08:00");
  assert.equal(parseWakeRequest("明天9点提醒我起床", now).startAt, "2026-08-05T09:00:00+08:00");
  assert.equal(parseWakeRequest("今天23点提醒我起床", now).startAt, "2026-08-04T23:00:00+08:00");
  assert.equal(
    parseWakeRequest("8月4日9点提醒我起床", new Date("2026-08-04T02:16:00+08:00")).startAt,
    "2026-08-04T09:00:00+08:00",
  );
});

test("the core returns null for unmatched free chat", async (t) => {
  const fixture = await createFixture(t);
  const currentPlugin = pluginRecord();
  const registry = {
    plugins: [currentPlugin],
    byMenuIndex: new Map([[1, currentPlugin]]),
    byExactCommand: new Map([
      ["/计划", currentPlugin],
      ["/计划详细", currentPlugin],
    ]),
    failures: [],
  };
  const route = createPluginRouter({ registry, planRoot: PLAN_ROOT });
  assert.equal(await route("我们聊聊哈利波特", fixture.context), null);
  assert.equal(await route("我已睡觉了", fixture.context), null);
  assert.equal(await route("好的，收到", fixture.context), null);
});

test("selected read-only replies remain identical to the installed old router", async (t) => {
  if (!hasIndependentLegacyRouter()) {
    t.skip("installed router is the canonical adapter, not an independent compatibility oracle");
    return;
  }
  const fixture = await createFixture(t);
  const oldDb = path.join(fixture.root, "old.sqlite");
  const oldContext = { ...fixture.context, sqlitePath: oldDb, planRuntime: undefined };
  const oldRuntime = createPlanRuntime(oldContext);
  for (const runtime of [fixture.baseRuntime, oldRuntime]) {
    await runtime.runPlanner([
      "save-plan",
      "--payload-base64",
      payloadBase64({
        date: "2026-08-03",
        rawText: "今日计划\n14:00 - 15:00 背单词",
        items: [{ startTime: "14:00", endTime: "15:00", title: "背单词" }],
      }),
    ]);
    await runtime.runPlanner([
      "save-daily-record",
      "--payload-base64",
      payloadBase64({
        date: "2026-08-03",
        studyMinutes: 60,
        entertainmentMinutes: 30,
        other: [],
        readingWords: 200,
        rawText: "今日记录",
      }),
    ]);
  }

  const previousDb = process.env.OPENCLAW_PLANNER_DB_PATH;
  process.env.OPENCLAW_PLANNER_DB_PATH = oldDb;
  t.after(() => {
    if (previousDb === undefined) delete process.env.OPENCLAW_PLANNER_DB_PATH;
    else process.env.OPENCLAW_PLANNER_DB_PATH = previousDb;
  });
  const oldUrl = `${pathToFileURL(OLD_FAST_ROUTINE).href}?oracle=${Date.now()}`;
  const old = await import(oldUrl);

  for (const message of ["今天计划", "今天记录"]) {
    assert.equal((await handle(message, fixture.context)).reply, old.handleFastRoutineCommand(message).reply);
  }
  const now = new Date("2026-08-03T09:00:00+08:00");
  assert.deepEqual(
    parseGeneralReminder("提醒我明天12点有个会议", now),
    old.parseGeneralReminder("提醒我明天12点有个会议", now),
  );
});

test("old and new mutating routes keep command names and resulting rows compatible", async (t) => {
  if (!hasIndependentLegacyRouter()) {
    t.skip("installed router is the canonical adapter, not an independent compatibility oracle");
    return;
  }
  const fixture = await createFixture(t, new Date("2026-08-03T02:10:18+08:00"));
  const oldDb = path.join(fixture.root, "old-mutations.sqlite");
  const oldRoutine = path.join(fixture.root, "old-routine.json");
  const previous = {
    db: process.env.OPENCLAW_PLANNER_DB_PATH,
    routine: process.env.OPENCLAW_ROUTINE_STATE_PATH,
  };
  process.env.OPENCLAW_PLANNER_DB_PATH = oldDb;
  process.env.OPENCLAW_ROUTINE_STATE_PATH = oldRoutine;
  t.after(() => {
    if (previous.db === undefined) delete process.env.OPENCLAW_PLANNER_DB_PATH;
    else process.env.OPENCLAW_PLANNER_DB_PATH = previous.db;
    if (previous.routine === undefined) delete process.env.OPENCLAW_ROUTINE_STATE_PATH;
    else process.env.OPENCLAW_ROUTINE_STATE_PATH = previous.routine;
  });
  const old = await import(`${pathToFileURL(OLD_FAST_ROUTINE).href}?mutations=${Date.now()}`);
  const combined = [
    "今日计划",
    "00:00 - 00:01 兼容测试",
    "今日记录",
    "学习：1h",
    "娱乐：2h",
    "英文小说：100字",
  ].join("\n");
  const oldCombined = old.handleFastRoutineCommand(combined);
  const newCombined = await handle(combined, fixture.context);
  assert.equal(newCombined.command, oldCombined.command);
  const fixedSleep = new Date("2026-08-03T02:10:18+08:00");
  assert.equal((await handle("已睡觉", fixture.context)).command, old.handleFastRoutineCommand("已睡觉", fixedSleep).command);

  function snapshot(dbPath) {
    const db = new DatabaseSync(dbPath);
    try {
      return {
        plans: db.prepare("SELECT plan_date,start_time,end_time,title,actual_status FROM plan_items ORDER BY start_time").all(),
        records: db.prepare("SELECT record_date,study_minutes,entertainment_minutes,reading_words FROM daily_records").all(),
        sleeps: db.prepare("SELECT routine_date,substr(slept_at,1,19) slept_at FROM sleep_events").all(),
      };
    } finally {
      db.close();
    }
  }
  assert.deepEqual(snapshot(fixture.sqlitePath), snapshot(oldDb));
});
