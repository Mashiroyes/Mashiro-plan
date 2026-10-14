import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { handle, match } from "../../mashirobot-plugin-language/index.mjs";


test("all requested English chart phrases return a Python PNG", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "english-skills-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keywords = path.join(root, "english-skill-keywords.json");
  await copyFile(path.resolve(import.meta.dirname, "../../mashirobot-plugin-language/config/english-skill-keywords.json"), keywords);
  const context = {
    sqlitePath: path.join(root, "planner.sqlite"), tempRoot: path.join(root, "temp"),
    englishKeywordsPath: keywords, now: new Date("2026-08-09T12:00:00+08:00"),
  };
  const runtime = createPlanRuntime(context);
  await createPlanRuntime(context).runPlanner(["save-daily-record", "--payload-base64", Buffer.from(JSON.stringify({ date: "2026-08-02", readingTitle: "Hyperion", readingWords: 1234, rawText: "今日记录" }), "utf8").toString("base64")]);
  await runtime.runPlanner(["save-plan", "--payload-base64", Buffer.from(JSON.stringify({ date: "2026-08-02", rawText: "计划", items: [{ startTime: "10:00", endTime: "11:00", title: "Hyperion" }] }), "utf8").toString("base64")]);
  const learnedSummary = await runtime.runPlanner(["query-english-skills", "--from", "2026-08-02", "--to", "2026-08-02", "--granularity", "day"]);
  assert.equal(learnedSummary.totals.reading, 60);
  for (const [date, title] of [["2026-08-03", "英语听力"], ["2026-08-04", "英语口语"], ["2026-08-05", "哈利波特"], ["2026-08-06", "英语作文"]]) {
    await runtime.runPlanner(["save-plan", "--payload-base64", Buffer.from(JSON.stringify({ date, rawText: "计划", items: [{ startTime: "10:00", endTime: "11:00", title }] }), "utf8").toString("base64")]);
  }
  for (const phrase of ["本周英语学习统计图", "本周英语统计图", "这个月英语学习统计图", "这个月英语统计图", "今年英语学习统计图", "今年英语统计图"]) {
    assert.equal(match(phrase, context), true, phrase);
    const result = await handle(phrase, context);
    assert.equal(result.command, "英语学习统计图", phrase);
    assert.equal(result.mediaPaths.length, 1, phrase);
    assert.equal(existsSync(result.mediaPaths[0]), true, phrase);
  }
});

test("TED-Ed listening input persists through the real planner runtime", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "teded-listening-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = {
    sqlitePath: path.join(root, "planner.sqlite"),
    tempRoot: path.join(root, "temp"),
    now: new Date("2026-10-12T09:30:00+08:00"),
  };
  const phrase = "今日英语听力：12 What staying up all night does to your brain - Anna Rothschild";
  const result = await handle(phrase, context);
  assert.equal(result.command, "记录TED-Ed英语听力");
  assert.match(result.reply, /10月14日、10月19日、11月2日、12月11日/u);
  const state = await createPlanRuntime(context).runPlanner([
    "get-plugin-state", "--plugin-id", "mashirobot-plugin-language", "--state-key", "teded-listening:v1",
  ]);
  assert.equal(state.found, true);
  assert.deepEqual(state.value.videos[0], {
    number: 12,
    title: "What staying up all night does to your brain - Anna Rothschild",
    studiedOn: "2026-10-12",
    reviewDates: ["2026-10-14", "2026-10-19", "2026-11-02", "2026-12-11"],
  });
});
