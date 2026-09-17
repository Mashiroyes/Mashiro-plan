import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildFeedbackPrompt, generateChatFeedback, runChatFeedback, validateFeedbackOutput } from "../runtime/chat-feedback.mjs";

const lesson = {
  company: "伊利股份", title: "收入与利润", question: "收入和利润有什么区别？",
  referencePoints: ["收入不等于利润", "还要扣除成本费用"],
};
const validText = "【你答对了什么】你正确指出收入不是最终留下的钱。\n【还缺什么】还可以说明成本、费用和税会继续从收入中扣除。\n【更好的理解】收入像商店收银台记下的销售额，利润才是扣掉进货、工资、房租等之后剩下的部分；现金又取决于顾客是否已经付款。把三者分开，才能避免把卖得多误判成赚得多。\n【下一步】用10分钟从原文找出收入、净利润和经营现金流三个数字，并逐一写明期间和单位。\n仅用于财报学习，不构成投资建议。";

test("prompt requests four sections, 300-500 Chinese characters and no investment advice", () => {
  const prompt = buildFeedbackPrompt({ lesson, answer: "收入高不等于利润高" });
  assert.match(prompt, /300—500字/);
  for (const heading of ["【你答对了什么】", "【还缺什么】", "【更好的理解】", "【下一步】"]) assert.match(prompt, new RegExp(heading));
  assert.match(prompt, /不构成投资建议/);
});

test("chat invocation uses only OpenClaw agent chat contract", () => {
  let capture;
  const mock = (command, args, options) => {
    capture = { command, args, options };
    return { status: 0, stdout: JSON.stringify({ reply: validText }), stderr: "" };
  };
  const response = runChatFeedback({ openclawPath: "C:\\tools\\openclaw.cmd", sessionKey: "agent:main:financial-report-feedback:1", promptFile: "C:\\temp\\prompt.txt", spawnSyncImpl: mock });
  assert.equal(response.ok, true);
  assert.equal(capture.command, "C:\\tools\\openclaw.cmd");
  assert.deepEqual(capture.args, ["agent", "--session-key", "agent:main:financial-report-feedback:1", "--message-file", "C:\\temp\\prompt.txt", "--json", "--thinking", "low"]);
  assert.equal(capture.options.windowsHide, true);
  assert.equal(capture.options.shell, process.platform === "win32");
  assert.doesNotMatch([capture.command, ...capture.args].join(" "), /codex|paseo|goal|workspace|worktree|--deliver|work[-_ ]?mode/iu);
});

test("temporary UTF-8 prompt is deleted even after chat returns", () => {
  let promptPath;
  const mock = (_command, args) => {
    promptPath = args[args.indexOf("--message-file") + 1];
    assert.equal(existsSync(promptPath), true);
    return { status: 0, stdout: JSON.stringify({ output: validText }), stderr: "" };
  };
  generateChatFeedback({ lesson, answer: "回答", openclawPath: "openclaw.cmd", sessionKey: "agent:main:financial-report-feedback:2", spawnSyncImpl: mock });
  assert.equal(existsSync(promptPath), false);
});

test("extracts the real OpenClaw result.payloads text shape", () => {
  const mock = () => ({ status: 0, stdout: JSON.stringify({
    status: "ok", result: { payloads: [{ text: validText }], meta: { finalAssistantVisibleText: validText } },
  }), stderr: "" });
  const response = runChatFeedback({ openclawPath: "openclaw.cmd", sessionKey: "agent:main:financial-report-feedback:shape", promptFile: "prompt.txt", spawnSyncImpl: mock });
  assert.equal(response.text, validText);
});

test("rejects empty, error, oversized, incomplete and stock-operation output", () => {
  assert.throws(() => validateFeedbackOutput(""), /没有返回/);
  assert.throws(() => validateFeedbackOutput("x".repeat(1501)), /1500/);
  assert.throws(() => validateFeedbackOutput("【你答对了什么】只有一段"), /缺少段落/);
  assert.throws(() => validateFeedbackOutput(validText.replace("仅用于财报学习", "建议买入这只股票。仅用于财报学习")), /股票操作建议/);
  assert.throws(() => runChatFeedback({ openclawPath: "openclaw.cmd", sessionKey: "agent:main:financial-report-feedback:3", promptFile: "p", spawnSyncImpl: () => ({ status: 0, stdout: JSON.stringify({ error: "bad" }), stderr: "" }) }), /返回错误/);
});
