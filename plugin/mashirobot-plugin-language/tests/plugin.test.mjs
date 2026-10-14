import test from "node:test";
import assert from "node:assert/strict";

import { handle, match } from "../index.mjs";

const statistics = {
  fromDate: "2026-09-14",
  toDate: "2026-09-16",
  totals: { listening: 60, speaking: 20, reading: 120, writing: 30, anki: 10 },
  percentages: { listening: 25, speaking: 8.3, reading: 50, writing: 12.5, anki: 4.2 },
  inactivityWarning: "间隔提醒：口语暂无训练记录。",
};

function fixtureRuntime(overrides = {}) {
  return {
    async runPlanner(args) {
      if (args[0] === "query-english-skills") return statistics;
      if (args[0] === "get-plugin-state") return { found: false, value: null };
      if (args[0] === "set-plugin-state") {
        return { value: JSON.parse(Buffer.from(args[args.indexOf("--payload-base64") + 1], "base64").toString("utf8")) };
      }
      if (args[0] === "manage-english-keywords") {
        const action = args[args.indexOf("--action") + 1];
        if (action === "list") return { keywords: { reading: { builtIn: ["哈利波特"], custom: [] } } };
        return { changed: true, category: "reading", keyword: "瓦尔登湖", keywords: { reading: { builtIn: [], custom: ["瓦尔登湖"] } }, rebuild: { completed: true, scanned: 2 } };
      }
      throw new Error("unexpected command");
    },
    async generateEnglishSkillsChart() { return "cached.png"; },
    copyChartForUse(paths) { return paths.map(() => "outbound.png"); },
    ...overrides,
  };
}

test("matches all statistic aliases", () => {
  for (const phrase of ["英语统计", "英语统计图", "本周英语学习统计图", "本周英语统计图", "这周英语统计图", "上周英语统计图", "这个月英语学习统计图", "本月英语统计图", "上个月英语统计图", "今年英语统计图", "本年英语学习统计图", "去年英语统计图"]) {
    assert.equal(match(phrase), true, phrase);
  }
});

test("records a TED-Ed listening video and schedules expanding reviews", async () => {
  let saved = null;
  const runtime = fixtureRuntime({
    async runPlanner(args) {
      if (args[0] === "get-plugin-state") return { found: false, value: null };
      if (args[0] === "set-plugin-state") {
        saved = JSON.parse(Buffer.from(args[args.indexOf("--payload-base64") + 1], "base64").toString("utf8"));
        return { value: saved };
      }
      throw new Error("unexpected command");
    },
  });
  const phrase = "今日英语听力：12  What staying up all night does to your brain - Anna Rothschild";
  assert.equal(match(phrase), true);
  const result = await handle(phrase, { planRuntime: runtime, now: new Date("2026-10-12T09:30:00+08:00") });
  assert.equal(result.command, "记录TED-Ed英语听力");
  assert.match(result.reply, /已记录 #12/u);
  assert.match(result.reply, /10月14日、10月19日、11月2日、12月11日/u);
  assert.deepEqual(saved, {
    version: 1,
    videos: [{
      number: 12,
      title: "What staying up all night does to your brain - Anna Rothschild",
      studiedOn: "2026-10-12",
      reviewDates: ["2026-10-14", "2026-10-19", "2026-11-02", "2026-12-11"],
    }],
  });
});

test("re-sending a TED-Ed number updates its title without resetting the review dates", async () => {
  const original = {
    version: 1,
    videos: [{ number: 12, title: "Old title", studiedOn: "2026-10-10", reviewDates: ["2026-10-12", "2026-10-17", "2026-10-31", "2026-12-09"] }],
  };
  let saved = null;
  const runtime = fixtureRuntime({
    async runPlanner(args) {
      if (args[0] === "get-plugin-state") return { found: true, value: original };
      if (args[0] === "set-plugin-state") {
        saved = JSON.parse(Buffer.from(args[args.indexOf("--payload-base64") + 1], "base64").toString("utf8"));
        return { value: saved };
      }
      throw new Error("unexpected command");
    },
  });
  const result = await handle("今日英语听力: 12 Corrected title", { planRuntime: runtime, now: new Date("2026-10-12T18:00:00+08:00") });
  assert.match(result.reply, /已更新 #12 的标题/u);
  assert.equal(saved.videos[0].title, "Corrected title");
  assert.equal(saved.videos[0].studiedOn, "2026-10-10");
  assert.deepEqual(saved.videos[0].reviewDates, original.videos[0].reviewDates);
});

test("monthly daily targets persist under the selected calendar month", async () => {
  const calls = [];
  const runtime = fixtureRuntime({
    async runPlanner(args) {
      calls.push(args);
      return { value: JSON.parse(Buffer.from(args[args.indexOf("--payload-base64") + 1], "base64").toString("utf8")) };
    },
  });
  const result = await handle("7月目标每天时长：2小时30分钟", {
    planRuntime: runtime, now: new Date("2026-09-22T12:00:00+08:00"),
  });
  assert.equal(result.command, "设置英语学习目标");
  assert.match(result.reply, /2026年7月每日目标：2小时30分钟/u);
  assert.deepEqual(calls[0].slice(0, 5), ["set-plugin-state", "--plugin-id", "mashirobot-plugin-language", "--state-key", "daily-target:2026-07"]);
});

test("monthly target accepts the short keyword and h duration", async () => {
  const calls = [];
  const runtime = fixtureRuntime({
    async runPlanner(args) {
      calls.push(args);
      return { value: JSON.parse(Buffer.from(args[args.indexOf("--payload-base64") + 1], "base64").toString("utf8")) };
    },
  });
  const result = await handle("本月目标时长：7h", {
    planRuntime: runtime, now: new Date("2026-09-22T12:00:00+08:00"),
  });
  assert.match(result.reply, /2026年9月每日目标：7小时/u);
  assert.equal(JSON.parse(Buffer.from(calls[0].at(-1), "base64").toString("utf8")).dailyMinutes, 420);
});

test("a monthly chart carries its saved daily target into the renderer", async () => {
  let rendered = null;
  const runtime = fixtureRuntime({
    async runPlanner(args) {
      if (args[0] === "query-english-skills") return statistics;
      if (args[0] === "get-plugin-state") return { found: true, value: { dailyMinutes: 180 } };
      throw new Error("unexpected command");
    },
    async generateEnglishSkillsChart(payload) { rendered = payload; return "cached.png"; },
  });
  await handle("本月英语统计图", { planRuntime: runtime, now: new Date("2026-09-22T12:00:00+08:00") });
  assert.equal(rendered.dailyTargetMinutes, 180);
});

test("study-duration simulations use real monthly points without changing them", async () => {
  const monthlyStatistics = {
    fromDate: "2026-09-01",
    toDate: "2026-09-22",
    totals: { listening: 60, speaking: 0, reading: 120, writing: 120, anki: 1000 },
    points: [
      { label: "2026-09-20", listening: 60, speaking: 0, reading: 0, writing: 0 },
      { label: "2026-09-21", listening: 0, speaking: 0, reading: 120, writing: 0 },
      { label: "2026-09-22", listening: 0, speaking: 0, reading: 0, writing: 120 },
    ],
  };
  const calls = [];
  const runtime = fixtureRuntime({
    async runPlanner(args) {
      calls.push(args);
      if (args[0] === "query-english-skills") return monthlyStatistics;
      if (args[0] === "get-plugin-state") return { found: true, value: { dailyMinutes: 150 } };
      throw new Error("unexpected command");
    },
  });
  const context = { planRuntime: runtime, now: new Date("2026-09-22T12:00:00+08:00") };
  for (const [phrase, expected] of [
    ["如果今天学习8h", /平均每天：1小时40分钟 → 3小时40分钟[\s\S]*总学习时长：5小时 → 11小时[\s\S]*统计天数：3天 → 3天/u],
    ["如果明天学习8h", /平均每天：1小时40分钟 → 3小时15分钟[\s\S]*统计天数：3天 → 4天（\+1天）/u],
    ["如果昨天学习3h", /平均每天：1小时40分钟 → 2小时[\s\S]*总学习时长：5小时 → 6小时/u],
    ["如果未来7天每天学习8h", /平均每天：1小时40分钟 → 6小时6分钟[\s\S]*统计天数：3天 → 10天（\+7天）/u],
    ["如果接下来30天平均每天学习6.5h", /统计天数：3天 → 33天（\+30天）/u],
    ["如果今天不学习呢？", /平均每天：1小时40分钟 → 1小时[\s\S]*平均每天减少40分钟/u],
  ]) {
    assert.equal(match(phrase, context), true, phrase);
    const result = await handle(phrase, context);
    assert.equal(result.command, "学习时长假设模拟", phrase);
    assert.match(result.reply, expected, phrase);
    assert.match(result.reply, /本月真实记录/u, phrase);
    assert.deepEqual(result.mediaPaths, [], phrase);
  }
  assert.equal(monthlyStatistics.totals.writing, 120);
  assert.equal(calls.filter((args) => args[0] === "query-english-skills").length, 6);
});

test("matches common date prefixes with every requested statistic suffix", () => {
  const prefixes = ["今天", "昨天", "7月", "2025年7月", "2025年", "2026年7月15日", "本周", "上个月"];
  const suffixes = ["英语学习统计图", "英语学习", "英语统计图", "英语学习统计"];
  for (const prefix of prefixes) {
    for (const suffix of suffixes) assert.equal(match(`${prefix}${suffix}`), true, `${prefix}${suffix}`);
  }
});

test("specific month, year, and relative day select the expected ranges", async () => {
  const calls = [];
  const runtime = fixtureRuntime({
    async runPlanner(args) {
      if (args[0] === "get-plugin-state") return { found: false, value: null };
      if (args[0] !== "query-english-skills") throw new Error("unexpected command");
      calls.push(args);
      const from = args[args.indexOf("--from") + 1];
      const to = args[args.indexOf("--to") + 1];
      return { ...statistics, fromDate: from, toDate: to };
    },
  });
  const context = { planRuntime: runtime, now: new Date("2026-09-22T12:00:00+08:00") };
  for (const [phrase, from, to, granularity] of [
    ["7月英语学习统计图", "2026-07-01", "2026-07-31", "day"],
    ["2025年英语学习", "2025-01-01", "2025-12-31", "month"],
    ["今天英语统计图", "2026-09-22", "2026-09-22", "day"],
    ["昨天英语学习统计", "2026-09-21", "2026-09-21", "day"],
  ]) {
    const result = await handle(phrase, context);
    assert.equal(result.command, "英语学习统计图", phrase);
    const args = calls.at(-1);
    assert.equal(args[args.indexOf("--from") + 1], from, phrase);
    assert.equal(args[args.indexOf("--to") + 1], to, phrase);
    assert.equal(args[args.indexOf("--granularity") + 1], granularity, phrase);
  }
});

test("manual statistics reply contains only inactivity reminders", async () => {
  for (const phrase of ["英语统计", "英语统计图"]) {
    const result = await handle(phrase, { planRuntime: fixtureRuntime(), now: new Date("2026-09-16T12:00:00+08:00") });
    assert.equal(result.reply, "间隔提醒：口语暂无训练记录。", phrase);
    assert.doesNotMatch(result.reply, /五项|读：|%/u, phrase);
  }
});

test("statistics use the shared runtime and an outbound chart copy", async () => {
  const result = await handle("本周英语统计图", { planRuntime: fixtureRuntime(), now: new Date("2026-09-16T12:00:00+08:00") });
  assert.equal(result.command, "英语学习统计图");
  assert.equal(result.reply, "间隔提醒：口语暂无训练记录。");
  assert.deepEqual(result.mediaPaths, ["outbound.png"]);
});

test("chart failure preserves reminders and redacts local paths", async () => {
  const runtime = fixtureRuntime({
    async generateEnglishSkillsChart() { throw new Error("render failed at C:\\Users\\Private\\secret.png token=abc123"); },
  });
  const result = await handle("本周英语统计图", { planRuntime: runtime, now: new Date("2026-09-16T12:00:00+08:00") });
  assert.match(result.reply, /^间隔提醒：口语暂无训练记录。/u);
  assert.match(result.reply, /图表生成失败/u);
  assert.doesNotMatch(result.reply, /五项|读：|%/u);
  assert.doesNotMatch(result.reply, /Users|abc123/u);
  assert.deepEqual(result.mediaPaths, []);
});

test("keyword list and verified mutation keep existing replies", async () => {
  const runtime = fixtureRuntime();
  const listed = await handle("英语关键词", { planRuntime: runtime });
  assert.match(listed.reply, /阅读：哈利波特/u);
  assert.match(listed.reply, /英语关键词增加 阅读 上古卷轴5wiki/u);
  assert.match(listed.reply, /英语关键词删除 阅读 上古卷轴5wiki/u);
  const added = await handle("英语关键词增加 阅读 瓦尔登湖", { planRuntime: runtime });
  assert.match(added.reply, /已增加阅读关键词“瓦尔登湖”，已重新统计已有计划/u);
});

test("does not claim a rebuild when mutation verification is incomplete", async () => {
  const runtime = fixtureRuntime({
    async runPlanner() { return { changed: true, category: "reading", keyword: "瓦尔登湖", keywords: { reading: { builtIn: [], custom: [] } } }; },
  });
  const result = await handle("英语关键词增加 阅读 瓦尔登湖", { planRuntime: runtime });
  assert.match(result.reply, /历史统计重建结果未确认/u);
  assert.doesNotMatch(result.reply, /已重新统计/u);
});
