import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const planRoot = path.resolve(testDir, "..");
const rootReadmePath = path.join(planRoot, "README.md");
const pluginReadmePath = path.join(
  planRoot,
  "plugin",
  "mashirobot-plugin-plan",
  "README.md",
);

test("root README stays system-level and links to the plan plugin guide", async () => {
  const text = await readFile(rootReadmePath, "utf8");

  assert.match(text, /plugin\\mashirobot-plugin-plan/);
  assert.match(text, /\|\s*菜单编号\s*\|/);
  assert.match(text, /\|\s*1\s*\|\s*`plugin\\mashirobot-plugin-plan`\s*\|/);
  assert.match(text, /\|\s*4\s*\|\s*`plugin\\mashirobot-plugin-loot`\s*\|/);
  assert.match(
    text,
    /\[[^\]]+\]\(plugin\/mashirobot-plugin-plan\/README\.md\)/,
  );

  for (const forbidden of [
    "/计划详细",
    "sleep_events",
    "general_reminders",
    "OpenClaw-Daily-Water-1000",
    "mashirobot-plugin-note",
    "添加笔记",
  ]) {
    assert.equal(
      text.includes(forbidden),
      false,
      `root README must not duplicate plan-plugin detail: ${forbidden}`,
    );
  }
});

test("plan plugin README is the complete operational reference", async () => {
  const text = await readFile(pluginReadmePath, "utf8");

  for (const required of [
    "/计划",
    "/计划详细",
    "00:00 至 05:59",
    "收到",
    "plan\\sqlite\\openclaw-planner.sqlite",
    "Windows 计划任务",
    "健康检查",
    "测试",
    "README.md",
  ]) {
    assert.ok(text.includes(required), `plugin README is missing: ${required}`);
  }
});

test("root README links menu 5 without duplicating financial plugin internals", async () => {
  const root = await readFile(rootReadmePath, "utf8");
  assert.match(root, /\|\s*5\s*\|\s*`plugin\\mashirobot-plugin-financial-report`\s*\|/);
  assert.match(root, /\(plugin\/mashirobot-plugin-financial-report\/README\.md\)/);
  for (const internal of ["financial_report_course_state", "补学招股书第N课", "agent:main:financial-report-feedback:"]) {
    assert.equal(root.includes(internal), false);
  }

  const financial = await readFile(path.join(planRoot, "plugin", "mashirobot-plugin-financial-report", "README.md"), "utf8");
  for (const required of ["每天 12:20", "每周二、周五 18:10", "补学第N天", "补学招股书第N课", "聊天模式", "financial_report_course_state", "MashiroBot Financial Report Daily", "测试"]) {
    assert.ok(financial.includes(required), `financial plugin README is missing: ${required}`);
  }
});
