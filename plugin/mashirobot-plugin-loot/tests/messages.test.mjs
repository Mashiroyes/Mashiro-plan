import assert from "node:assert/strict";
import test from "node:test";

import { buildEveningReminder, buildReplayMessage } from "../core/messages.mjs";

test("builds the exact morning replay without rewriting content", () => {
  assert.equal(
    buildReplayMessage("2026-08-18", "读完一章\n听懂一段"),
    "与其整天沉醉于别人的故事，不如自己安心多学一些，也留下点自己的故事。\n\n" +
      "2026年8月18日的爽点：\n读完一章\n听懂一段",
  );
});

test("keeps the evening reminder short and category-free", () => {
  const message = buildEveningReminder();
  assert.match(message, /记录今天的爽点/);
  assert.doesNotMatch(message, /英语阅读|英语听力|英语对话|排行榜|积分/);
});
