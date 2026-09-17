#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getFinancialReportSlot, getProspectusSlot } from "../core/calendar.mjs";
import { formatLessonCard, getLesson, loadCurriculum } from "../core/curriculum.mjs";
import { createLearningStore } from "../core/storage.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new TypeError(`无法识别参数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (rest[index + 1]?.startsWith("--") || rest[index + 1] == null) values[key] = true;
    else values[key] = rest[++index];
  }
  return values;
}

function required(args, key) {
  if (!args[key]) throw new TypeError(`缺少 --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  return args[key];
}

function sourcesFor(curriculum, lesson) {
  const ids = new Set([lesson.sourceId, ...lesson.facts.map((fact) => fact.sourceId).filter(Boolean)]);
  return curriculum.sources.filter((source) => ids.has(source.sourceId));
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function runCli(argv) {
  const args = parseArgs(argv);
  const command = required(args, "command");
  const sqlitePath = resolve(required(args, "sqlitePath"));
  const accountId = String(args.accountId ?? "default");
  const conversationId = String(args.conversationId ?? "default");
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError("--now 不是有效时间");
  const defaultRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const pluginRoot = resolve(args.pluginRoot ?? defaultRoot);
  const store = createLearningStore(sqlitePath);
  try {
    if (command === "init") {
      return { action: "initialized", states: store.initialize({
        accountId, conversationId, installedDate: required(args, "installedDate"),
      }) };
    }
    if (command === "prepare-delivery") {
      const courseType = required(args, "courseType");
      const state = store.getCourseState(accountId, conversationId, courseType);
      if (!state) throw new Error("课程尚未初始化");
      const slot = courseType === "financial_report" ? getFinancialReportSlot(state, now) : getProspectusSlot(state, now);
      if (!slot.eligible) return { action: slot.reason, slot };
      const claim = store.claimDelivery({ accountId, conversationId, courseType,
        lessonNumber: slot.lessonNumber, scheduledDate: slot.localDate, now });
      if (!claim.claimed) return { action: claim.reason === "already_sent" ? "already_sent" : "not_due", slot };
      const curriculum = loadCurriculum(pluginRoot);
      const lesson = getLesson(curriculum, courseType, slot.lessonNumber);
      const sources = sourcesFor(curriculum, lesson);
      if (!sources.length || sources.some((source) => !source.sha256 || !source.officialUrl.startsWith("https://"))) {
        store.finishDelivery(claim.delivery.id, { success: false, error: "课程官方来源校验失败", now });
        throw new Error("课程官方来源校验失败");
      }
      let message = formatLessonCard(lesson, sources);
      if (courseType === "prospectus" && slot.lessonNumber === 8) {
        message += "\n\n第一批 8 节招股书课程已完成。之后仍可随时使用“补学招股书第N课”复习。";
      }
      return { action: "send", deliveryId: Number(claim.delivery.id), courseType,
        lessonNumber: slot.lessonNumber, scheduledDate: slot.localDate,
        messageBase64: Buffer.from(message, "utf8").toString("base64") };
    }
    if (command === "finish-delivery") {
      const success = args.success === "true" || args.success === true;
      const row = store.finishDelivery(Number(required(args, "deliveryId")), {
        success, error: args.errorBase64 ? Buffer.from(args.errorBase64, "base64").toString("utf8") : null, now,
      });
      const finalLesson = row.course_type === "financial_report" ? 30 : 8;
      if (success && row.lesson_number === finalLesson) store.markCourseComplete(row.account_id, row.conversation_id, row.course_type, now);
      return { action: success ? "sent" : "failed", deliveryId: row.id };
    }
    if (command === "claim-feedback") {
      const feedback = store.claimPendingFeedback({ now });
      if (!feedback) return { action: "feedback", feedback: null };
      const { answer_text: answerText, ...safe } = feedback;
      return { action: "feedback", feedback: { ...safe, answerTextBase64: Buffer.from(answerText, "utf8").toString("base64") } };
    }
    if (command === "finish-feedback") {
      const text = Buffer.from(required(args, "outputBase64"), "base64").toString("utf8");
      return { action: "feedback_finished", feedback: store.finishFeedback(Number(required(args, "feedbackId")), text, { sent: args.sent === "true", now }) };
    }
    if (command === "fail-feedback") {
      const error = Buffer.from(required(args, "errorBase64"), "base64").toString("utf8");
      return { action: "feedback_failed", feedback: store.failFeedback(Number(required(args, "feedbackId")), error, { now }) };
    }
    if (command === "progress") return { action: "progress", progress: store.listProgress(accountId, conversationId) };
    throw new TypeError(`未知命令: ${command}`);
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { output(runCli(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
}
