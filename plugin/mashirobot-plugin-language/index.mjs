import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPlanRuntime, plannerRuntimePaths } from "../mashirobot-plugin-plan/bridge/planner-runner.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultKeywordsPath = path.join(pluginRoot, "config", "english-skill-keywords.json");
const LABELS = { listening: "听", speaking: "说", reading: "读", writing: "写", anki: "Anki" };
const KEYWORD_LABELS = { listening: "听力", speaking: "口语", reading: "阅读", writing: "写作" };

function parseStatistics(rawText) {
  if (/\r?\n/u.test(String(rawText))) return null;
  const text = String(rawText).trim().replace(/\s+/gu, "");
  if (/^英语(?:学习)?统计(?:图)?$/u.test(text)) return { kind: "week", offset: 0, label: "本周" };
  const match = /^(本周|这周|上周|这个月|本月|上个月|上月|今年|本年|去年)英语(?:学习)?统计图$/u.exec(text);
  if (!match) return null;
  const target = match[1];
  if (["本周", "这周"].includes(target)) return { kind: "week", offset: 0, label: "本周" };
  if (target === "上周") return { kind: "week", offset: -1, label: "上周" };
  if (["这个月", "本月"].includes(target)) return { kind: "month", offset: 0, label: "本月" };
  if (["上个月", "上月"].includes(target)) return { kind: "month", offset: -1, label: "上个月" };
  return { kind: "year", offset: ["今年", "本年"].includes(target) ? 0 : -1, label: ["今年", "本年"].includes(target) ? "今年" : "去年" };
}

function parseKeywords(rawText) {
  if (/\r?\n/u.test(String(rawText))) return null;
  const text = String(rawText).trim();
  if (/^英语关键词(?:查看)?$/u.test(text)) return { action: "list" };
  const match = /^英语关键词(?:增加|添加)\s*(听|听力|说|口语|读|阅读|写|写作)\s+(.+)$/u.exec(text);
  if (match) return { action: "add", category: match[1], keyword: match[2].trim() };
  const remove = /^英语关键词(?:删除|移除)\s*(听|听力|说|口语|读|阅读|写|写作)\s+(.+)$/u.exec(text);
  return remove ? { action: "remove", category: remove[1], keyword: remove[2].trim() } : null;
}

function range(parsed, now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).filter((part) => ["year", "month", "day"].includes(part.type)).map((part) => [part.type, Number(part.value)]));
  const date = (value) => value.toISOString().slice(0, 10);
  const today = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  if (parsed.kind === "week") {
    const current = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const day = current.getUTCDay() || 7;
    const monday = new Date(current); monday.setUTCDate(current.getUTCDate() + 1 - day + parsed.offset * 7);
    const end = new Date(monday); end.setUTCDate(monday.getUTCDate() + 6);
    return { from: date(monday), to: date(end) > today ? today : date(end), granularity: "day" };
  }
  if (parsed.kind === "month") {
    const month = parts.month - 1 + parsed.offset;
    const from = new Date(Date.UTC(parts.year, month, 1));
    const end = new Date(Date.UTC(parts.year, month + 1, 0));
    return { from: date(from), to: date(end) > today ? today : date(end), granularity: "day" };
  }
  const year = parts.year + parsed.offset;
  return { from: `${year}-01-01`, to: `${year}-12-31` > today ? today : `${year}-12-31`, granularity: "month" };
}

function minutes(value) {
  const total = Math.round(Number(value ?? 0));
  return total >= 60 ? `${Math.floor(total / 60)}小时${total % 60 ? `${total % 60}分钟` : ""}` : `${total}分钟`;
}

function shortError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Za-z]:[\\/][^\s"']+/gu, "<path>")
    .replace(/(token|secret|password|key)\s*[=:]\s*[^\s,;]+/giu, "$1=<redacted>")
    .replace(/\s+/gu, " ")
    .slice(0, 220);
}

function statisticsReply(result, label) {
  return [`${label}英语五项学习统计（${result.fromDate} 至 ${result.toDate}）：`, ...Object.entries(LABELS).map(([key, name]) => `${name}：${minutes(result.totals?.[key])}（${Number(result.percentages?.[key] ?? 0).toFixed(1)}%）`), result.warning, result.inactivityWarning].filter(Boolean).join("\n");
}

function validateKeywordResult(result, command) {
  if (!result || typeof result !== "object" || !result.keywords || typeof result.keywords !== "object") {
    throw new Error("关键词操作结果缺少已验证的关键词清单");
  }
  if (command.action !== "list" && typeof result.changed !== "boolean") {
    throw new Error("关键词操作结果缺少变更状态");
  }
  if (command.action !== "list" && result.changed && result.rebuild?.completed !== true) {
    throw new Error("关键词已修改，但历史统计重建结果未确认");
  }
}

function keywordReply(result, command) {
  validateKeywordResult(result, command);
  if (command.action === "list") return ["英语统计关键词：", ...Object.entries(result.keywords).map(([category, values]) => `${KEYWORD_LABELS[category]}：${values.builtIn.join("、")}${values.custom.length ? `；新增：${values.custom.join("、")}` : ""}`), "用法：英语关键词增加 阅读 上古卷轴5wiki"].join("\n");
  const label = KEYWORD_LABELS[result.category] ?? result.category;
  if (!result.changed) return `${label}关键词“${result.keyword}”${result.reason === "not-found" ? "没有找到" : "已存在"}，统计无需重算。`;
  return `${command.action === "add" ? "已增加" : "已删除"}${label}关键词“${result.keyword}”，已重新统计已有计划。`;
}

function runtimeFor(context) {
  return createPlanRuntime({ ...context, englishKeywordsPath: context.englishKeywordsPath ?? defaultKeywordsPath });
}

export function match(message) {
  const text = String(message ?? "").trim();
  return text === "/语言" || text === "/语言详细" || parseStatistics(text) !== null || parseKeywords(text) !== null;
}

export async function handle(message, context = {}) {
  const text = String(message ?? "").trim();
  if (text === "/语言" || text === "/语言详细") {
    return await context.renderPluginHelp?.("mashirobot-plugin-language", { detailed: text === "/语言详细" })
      ?? { handled: true, command: "语言学习帮助", reply: getHelp().fallbackText, mediaPaths: [] };
  }
  try {
    const runtime = runtimeFor(context);
    const keywordCommand = parseKeywords(text);
    if (keywordCommand) {
      const result = await runtime.runPlanner(["manage-english-keywords", "--action", keywordCommand.action, ...(keywordCommand.category ? ["--category", keywordCommand.category] : []), ...(keywordCommand.keyword ? ["--keyword", keywordCommand.keyword] : [])]);
      return { handled: true, command: keywordCommand.action === "list" ? "查看英语关键词" : "管理英语关键词", reply: keywordReply(result, keywordCommand), mediaPaths: [] };
    }
    const parsed = parseStatistics(text);
    if (!parsed) throw new Error("无法识别语言学习指令");
    const selected = range(parsed, context.now ?? new Date());
    const result = await runtime.runPlanner(["query-english-skills", "--from", selected.from, "--to", selected.to, "--granularity", selected.granularity]);
    let mediaPaths = [];
    let suffix = "";
    try {
      const cached = await runtime.generateEnglishSkillsChart(result);
      mediaPaths = runtime.copyChartForUse ? runtime.copyChartForUse([cached]) : [cached];
    } catch (error) {
      suffix = `\n\n图表生成失败，文字统计仍可用：${shortError(error)}`;
    }
    return { handled: true, command: "英语学习统计图", reply: statisticsReply(result, parsed.label) + suffix, mediaPaths };
  } catch (error) {
    return { handled: true, command: "语言学习", reply: `语言学习功能失败：${shortError(error)}`, mediaPaths: [] };
  }
}

export function healthCheck() {
  return { ok: existsSync(plannerRuntimePaths.plannerCli) && existsSync(defaultKeywordsPath), name: "mashirobot-plugin-language" };
}

export function getHelp() {
  return { groups: [{ title: "英语统计", items: ["英语统计或英语统计图：默认查看本周听说读写与 Anki 的计划时长", "英语关键词：查看、增加或删除统计关键词"] }], detailedGroups: [{ title: "关键词指令", items: ["英语关键词增加 阅读 上古卷轴5wiki", "英语关键词删除 阅读 上古卷轴5wiki", "新增或删除后会重算已有计划"] }], fallbackText: "英语统计图\n英语关键词\n英语关键词增加 阅读 上古卷轴5wiki" };
}
