import assert from "node:assert/strict";
import test from "node:test";

import { parseLootCommand } from "../core/parser.mjs";

test("parses exact loot commands and preserves multiline content", () => {
  assert.deepEqual(parseLootCommand("爽点\r\n读完一章\r\n解决了配置问题"), {
    kind: "save",
    content: "读完一章\n解决了配置问题",
  });
  assert.deepEqual(parseLootCommand("/战利品"), { kind: "help", detailed: false });
  assert.deepEqual(parseLootCommand("/战利品详细"), { kind: "help", detailed: true });
});

test("rejects empty content without matching unrelated text", () => {
  assert.match(parseLootCommand("爽点").error, /内容/);
  assert.match(parseLootCommand("爽点\n   ").error, /内容/);
  assert.equal(parseLootCommand("今天的爽点\n读完一章"), null);
  assert.equal(parseLootCommand("闲聊"), null);
});
