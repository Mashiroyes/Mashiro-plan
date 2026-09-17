#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getLesson, loadCurriculum } from "../core/curriculum.mjs";

const PROHIBITED_OUTPUT = /(?:建议|推荐).{0,8}(?:买入|卖出|持有|加仓|减仓)|(?:买入|卖出|加仓|减仓).{0,8}(?:建议|推荐)/u;

export function buildFeedbackPrompt({ lesson, answer }) {
  return [
    "你是一个耐心、直接的财报入门陪练。请只对学习者的回答做个性化点评，不执行任何工作任务，不创建目标。",
    `课程：${lesson.company}｜${lesson.title}`,
    `题目：${lesson.question}`,
    `参考要点：${lesson.referencePoints.join("；")}`,
    `学习者回答：${answer}`,
    "请用中文写300—500字，严格分为四段并保留标题：",
    "【你答对了什么】指出回答中具体正确的地方。",
    "【还缺什么】只指出本题最关键的遗漏或混淆。",
    "【更好的理解】用普通人能理解的方式解释核心概念。",
    "【下一步】给一个10分钟内能完成的小练习。",
    "不得评价人格，不得提供股票买卖、持仓或价格预测建议。末尾写：仅用于财报学习，不构成投资建议。",
  ].join("\n");
}

function collectText(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectText(item, output));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["text", "content", "message", "reply", "output", "finalAssistantVisibleText", "finalAssistantRawText"].includes(key)) {
        collectText(item, output);
      } else if (item && typeof item === "object") {
        collectText(item, output);
      }
    }
  }
  return output;
}

export function validateFeedbackOutput(text) {
  const value = String(text ?? "").trim();
  if (!value) throw new Error("聊天模式没有返回点评内容");
  if (value.length > 1500) throw new Error("点评超过1500字的安全上限");
  for (const heading of ["【你答对了什么】", "【还缺什么】", "【更好的理解】", "【下一步】"]) {
    if (!value.includes(heading)) throw new Error(`点评缺少段落: ${heading}`);
  }
  if (PROHIBITED_OUTPUT.test(value)) throw new Error("点评包含股票操作建议");
  return value;
}

export function runChatFeedback({ openclawPath, sessionKey, promptFile, timeoutSeconds = 120, spawnSyncImpl = spawnSync }) {
  const args = ["agent", "--session-key", sessionKey, "--message-file", promptFile, "--json", "--thinking", "low"];
  const forbidden = /codex|paseo|goal|workspace|worktree|--deliver|work[-_ ]?mode/iu;
  if (forbidden.test([openclawPath, ...args].join(" "))) throw new Error("聊天调用意外包含工作模式参数");
  const completed = spawnSyncImpl(openclawPath, args, {
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`OpenClaw 聊天调用失败: ${String(completed.stderr ?? "").trim()}`);
  let parsed;
  try { parsed = JSON.parse(completed.stdout); } catch { throw new Error("OpenClaw 返回的不是有效 JSON"); }
  if (parsed.error || parsed.ok === false) throw new Error(`OpenClaw 返回错误: ${parsed.error?.message ?? parsed.error ?? "unknown"}`);
  const candidates = collectText(parsed).map((item) => item.trim()).filter(Boolean);
  const text = candidates.sort((a, b) => b.length - a.length)[0];
  return { ok: true, text: validateFeedbackOutput(text), command: openclawPath, args };
}

export function generateChatFeedback({ lesson, answer, openclawPath, sessionKey, timeoutSeconds, spawnSyncImpl }) {
  const directory = mkdtempSync(join(tmpdir(), "mashiro-chat-feedback-"));
  const promptFile = join(directory, "prompt.txt");
  try {
    writeFileSync(promptFile, buildFeedbackPrompt({ lesson, answer }), { encoding: "utf8", flag: "wx" });
    return runChatFeedback({ openclawPath, sessionKey, promptFile, timeoutSeconds, spawnSyncImpl });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[index + 1];
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const curriculum = loadCurriculum(resolve(args.pluginRoot));
    const lesson = getLesson(curriculum, args.courseType, Number(args.lessonNumber));
    const answer = Buffer.from(args.answerBase64, "base64").toString("utf8");
    const response = generateChatFeedback({ lesson, answer, openclawPath: args.openclawPath,
      sessionKey: args.sessionKey, timeoutSeconds: Number(args.timeoutSeconds ?? 120) });
    process.stdout.write(`${JSON.stringify({ ok: true, outputBase64: Buffer.from(response.text, "utf8").toString("base64") })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
