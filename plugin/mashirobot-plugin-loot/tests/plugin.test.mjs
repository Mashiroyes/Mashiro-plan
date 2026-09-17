import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeAllLootStores, createLootStore } from "../core/store.mjs";
import { getHelp, handle, healthCheck, match } from "../index.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-loot-plugin-"));
  t.after(() => {
    closeAllLootStores();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    sqlitePath: path.join(root, "planner.sqlite"),
    now: new Date("2026-08-18T13:30:00Z"),
    renderPluginHelp: (_id, { detailed }) => ({
      handled: true,
      command: detailed ? "插件详细帮助" : "插件帮助",
      reply: detailed ? "DETAIL" : "HELP",
      mediaPaths: [],
    }),
  };
}

test("exports the synchronous plugin contract", () => {
  for (const value of [match, handle, healthCheck, getHelp]) {
    assert.equal(typeof value, "function");
    assert.notEqual(value.constructor.name, "AsyncFunction");
  }
  assert.equal(healthCheck().ok, true);
});

test("saves and overwrites today's free-form loot", (t) => {
  const context = fixture(t);
  assert.equal(match("爽点\n第一版"), true);
  assert.equal(match("闲聊"), false);
  assert.match(handle("爽点", context).reply, /内容/);
  assert.match(handle("爽点\n第一版", context).reply, /已记录/);
  assert.match(handle("爽点\n第二版\n完整内容", context).reply, /已记录/);
  assert.equal(createLootStore(context.sqlitePath).get("2026-08-18").content, "第二版\n完整内容");
});

test("routes exact help commands and exposes no fixed categories", (t) => {
  const context = fixture(t);
  assert.equal(handle("/战利品", context).reply, "HELP");
  assert.equal(handle("/战利品详细", context).reply, "DETAIL");
  const help = JSON.stringify(getHelp());
  assert.match(help, /同一天最后一次/);
  assert.doesNotMatch(help, /英语阅读|英语听力|英语对话/);
});
