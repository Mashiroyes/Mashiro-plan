import test from "node:test";
import assert from "node:assert/strict";

import { handle, match } from "../index.mjs";

const statistics = {
  fromDate: "2026-09-14",
  toDate: "2026-09-16",
  totals: { listening: 60, speaking: 20, reading: 120, writing: 30, anki: 10 },
  percentages: { listening: 25, speaking: 8.3, reading: 50, writing: 12.5, anki: 4.2 },
};

function fixtureRuntime(overrides = {}) {
  return {
    async runPlanner(args) {
      if (args[0] === "query-english-skills") return statistics;
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

test("generic statistic phrases default to this week", async () => {
  for (const phrase of ["英语统计", "英语统计图"]) {
    const result = await handle(phrase, { planRuntime: fixtureRuntime(), now: new Date("2026-09-16T12:00:00+08:00") });
    assert.match(result.reply, /本周英语五项学习统计/u, phrase);
  }
});

test("statistics use the shared runtime and an outbound chart copy", async () => {
  const result = await handle("本周英语统计图", { planRuntime: fixtureRuntime(), now: new Date("2026-09-16T12:00:00+08:00") });
  assert.equal(result.command, "英语学习统计图");
  assert.match(result.reply, /本周英语五项学习统计/u);
  assert.match(result.reply, /读：2小时/u);
  assert.deepEqual(result.mediaPaths, ["outbound.png"]);
});

test("chart failure preserves exact text statistics and redacts local paths", async () => {
  const runtime = fixtureRuntime({
    async generateEnglishSkillsChart() { throw new Error("render failed at C:\\Users\\Private\\secret.png token=abc123"); },
  });
  const result = await handle("本周英语统计图", { planRuntime: runtime, now: new Date("2026-09-16T12:00:00+08:00") });
  assert.match(result.reply, /英语五项学习统计/u);
  assert.match(result.reply, /图表生成失败，文字统计仍可用/u);
  assert.doesNotMatch(result.reply, /Users|abc123/u);
  assert.deepEqual(result.mediaPaths, []);
});

test("keyword list and verified mutation keep existing replies", async () => {
  const runtime = fixtureRuntime();
  const listed = await handle("英语关键词", { planRuntime: runtime });
  assert.match(listed.reply, /阅读：哈利波特/u);
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
