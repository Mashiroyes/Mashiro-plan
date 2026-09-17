import assert from "node:assert/strict";
import test from "node:test";
import { getHelp, handle, healthCheck, match } from "../index.mjs";

test("exports synchronous plugin contract", () => {
  assert.equal(match("今日财报"), true);
  assert.equal(match("普通聊天"), false);
  assert.equal(handle.constructor.name, "Function");
  assert.equal(healthCheck().name, "mashirobot-plugin-financial-report");
  assert.ok(getHelp().groups.length > 0);
});

test("renders help through core context", () => {
  const result = handle("/财报课程", {
    renderPluginHelp(id, options) {
      return { handled: true, command: "帮助", reply: id, mediaPaths: [], options };
    },
  });
  assert.equal(result.reply, "mashirobot-plugin-financial-report");
});
