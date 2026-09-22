import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPlanRuntime, plannerRuntimePaths } from "../mashirobot-plugin-plan/bridge/planner-runner.mjs";
import { shiftDate } from "../mashirobot-plugin-plan/shared/dates.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultKeywordsPath = path.join(pluginRoot, "config", "english-skill-keywords.json");
const LABELS = { listening: "听", speaking: "说", reading: "读", writing: "写", anki: "Anki" };
const KEYWORD_LABELS = { listening: "听力", speaking: "口语", reading: "阅读", writing: "写作" };
const TARGET_PLUGIN_ID = "mashirobot-plugin-language";
const TARGET_KEY_PREFIX = "daily-target:";
const CORE_SKILLS = ["listening", "speaking", "reading", "writing"];

function parseStatistics(rawText) {
  if (/\r?\n/u.test(String(rawText))) return null;
  const text = String(rawText).trim().replace(/\s+/gu, "");
  const match = /^(.*?)(?:英语学习统计图|英语学习统计|英语统计图|英语统计|英语学习)$/u.exec(text);
  if (!match) return null;
  const target = match[1] || "本周";
  if (/^(?:今天|今日)$/u.test(target)) return { kind: "day", offset: 0, label: "今天" };
  if (/^(?:昨天|昨日)$/u.test(target)) return { kind: "day", offset: -1, label: "昨天" };
  if (["本周", "这周"].includes(target)) return { kind: "week", offset: 0, label: "本周" };
  if (target === "上周") return { kind: "week", offset: -1, label: "上周" };
  if (["这个月", "本月"].includes(target)) return { kind: "month", offset: 0, label: "本月" };
  if (["上个月", "上月"].includes(target)) return { kind: "month", offset: -1, label: "上个月" };
  if (["今年", "本年", "去年"].includes(target)) return { kind: "year", offset: ["今年", "本年"].includes(target) ? 0 : -1, label: ["今年", "本年"].includes(target) ? "今年" : "去年" };
  let explicit = /^(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日$/u.exec(target);
  if (explicit) return { kind: "day", year: explicit[1] ? Number(explicit[1]) : null, month: Number(explicit[2]), day: Number(explicit[3]), label: target };
  explicit = /^(20\d{2})-(\d{1,2})-(\d{1,2})$/u.exec(target);
  if (explicit) return { kind: "day", year: Number(explicit[1]), month: Number(explicit[2]), day: Number(explicit[3]), label: target };
  explicit = /^(?:(20\d{2})年)?(\d{1,2})月$/u.exec(target);
  if (explicit) return { kind: "month", year: explicit[1] ? Number(explicit[1]) : null, month: Number(explicit[2]), label: target };
  explicit = /^(20\d{2})年$/u.exec(target);
  return explicit ? { kind: "year", year: Number(explicit[1]), label: target } : null;
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

function currentDateParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).filter((part) => ["year", "month", "day"].includes(part.type)).map((part) => [part.type, Number(part.value)]));
}

function parseDailyTarget(rawText) {
  if (/\r?\n/u.test(String(rawText))) return null;
  const text = String(rawText).trim().replace(/\s+/gu, "");
  const match = /^(本月|这个月|(?:(20\d{2})年)?(\d{1,2})月)目标(?:每天)?时长[:：]?(.*)$/u.exec(text);
  if (!match) return null;
  const duration = match[4];
  let minutes = null;
  let parsed = /^(\d+(?:\.\d+)?)(?:小时|h)(?:(\d{1,2})分(?:钟)?)?$/iu.exec(duration);
  if (parsed) minutes = Math.round(Number(parsed[1]) * 60 + Number(parsed[2] ?? 0));
  if (!parsed) {
    parsed = /^(\d{1,4})分(?:钟)?$/u.exec(duration);
    if (parsed) minutes = Number(parsed[1]);
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    return { error: "目标时长请填写 1 分钟到 24 小时，例如“本月目标时长：3h”。" };
  }
  return {
    year: match[2] ? Number(match[2]) : null,
    month: match[3] ? Number(match[3]) : null,
    relative: ["本月", "这个月"].includes(match[1]),
    minutes,
  };
}

function parseStudyDuration(raw) {
  const text = String(raw).trim().replace(/\s+/gu, "");
  let match = /^(\d+(?:\.\d+)?)(?:h|小时)$/iu.exec(text);
  if (match) return Math.round(Number(match[1]) * 60);
  match = /^(\d{1,4})分(?:钟)?$/u.exec(text);
  return match ? Number(match[1]) : null;
}

function parseStudySimulation(rawText) {
  if (/\r?\n/u.test(String(rawText))) return null;
  const text = String(rawText).trim().replace(/\s+/gu, "").replace(/[？?。！!]+$/u, "");
  if (!text.startsWith("如果")) return null;
  let match = /^如果(?:未来|接下来)(\d{1,3})天(?:每天|平均每天)学习(.+?)(?:呢)?$/u.exec(text);
  if (match) {
    const days = Number(match[1]);
    const minutes = parseStudyDuration(match[2]);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60 || days < 1 || days > 366) {
      return { error: "模拟请填写 1 到 366 天，以及每天 0 分钟到 24 小时，例如“如果未来7天每天学习8h”。" };
    }
    return { kind: "future", days, dailyMinutes: minutes };
  }
  match = /^如果(今天|明天|昨天)不学习(?:呢)?$/u.exec(text);
  if (match) return { kind: "single", day: match[1], finalMinutes: 0 };
  match = /^如果(今天|明天|昨天)学习(.+?)(?:呢)?$/u.exec(text);
  if (!match) return null;
  const minutes = parseStudyDuration(match[2]);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) {
    return { error: "模拟学习时长请填写 0 分钟到 24 小时，例如“如果今天学习8h”。" };
  }
  return { kind: "single", day: match[1], finalMinutes: minutes };
}

function range(parsed, now) {
  const parts = currentDateParts(now);
  const date = (value) => value.toISOString().slice(0, 10);
  const today = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const validDate = (year, month, day) => {
    const value = new Date(Date.UTC(year, month - 1, day));
    return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day ? date(value) : null;
  };
  if (parsed.kind === "day") {
    let selected;
    if (parsed.day) selected = validDate(parsed.year ?? parts.year, parsed.month, parsed.day);
    else selected = date(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + parsed.offset)));
    if (!selected) throw new Error("日期不存在");
    if (selected > today) throw new Error("未来日期还没有学习记录");
    return { from: selected, to: selected, granularity: "day" };
  }
  if (parsed.kind === "week") {
    const current = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const day = current.getUTCDay() || 7;
    const monday = new Date(current); monday.setUTCDate(current.getUTCDate() + 1 - day + parsed.offset * 7);
    const end = new Date(monday); end.setUTCDate(monday.getUTCDate() + 6);
    return { from: date(monday), to: date(end) > today ? today : date(end), granularity: "day" };
  }
  if (parsed.kind === "month") {
    const month = parsed.month ? parsed.month - 1 : parts.month - 1 + parsed.offset;
    const year = parsed.year ?? parts.year;
    const from = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 0));
    if (date(from) > today) throw new Error("未来月份还没有学习记录");
    return { from: date(from), to: date(end) > today ? today : date(end), granularity: "day" };
  }
  const year = parsed.year ?? parts.year + parsed.offset;
  if (`${year}-01-01` > today) throw new Error("未来年份还没有学习记录");
  return { from: `${year}-01-01`, to: `${year}-12-31` > today ? today : `${year}-12-31`, granularity: "month" };
}

function monthKey(year, month) {
  return TARGET_KEY_PREFIX + year + "-" + String(month).padStart(2, "0");
}

function targetMonth(command, now) {
  const parts = currentDateParts(now);
  return { year: command.year ?? parts.year, month: command.month ?? parts.month };
}

async function readDailyTarget(runtime, selected) {
  if (selected.from.slice(0, 7) !== selected.to.slice(0, 7)) return null;
  const state = await runtime.runPlanner([
    "get-plugin-state", "--plugin-id", TARGET_PLUGIN_ID, "--state-key", TARGET_KEY_PREFIX + selected.from.slice(0, 7),
  ]);
  const minutes = Number(state?.value?.dailyMinutes);
  return state?.found === true && Number.isInteger(minutes) && minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}

function minutes(value) {
  const total = Math.round(Number(value ?? 0));
  return total >= 60 ? `${Math.floor(total / 60)}小时${total % 60 ? `${total % 60}分钟` : ""}` : `${total}分钟`;
}

function decimalHours(value) {
  return (Math.abs(Number(value)) / 60).toFixed(2);
}

function simulationRange(now) {
  const parts = currentDateParts(now);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return { from: `${parts.year}-${month}-01`, to: `${parts.year}-${month}-${day}`, granularity: "day" };
}

function totalMinutes(point) {
  return CORE_SKILLS.reduce((total, skill) => total + Math.max(0, Math.round(Number(point?.[skill] ?? 0))), 0);
}

function averageChangeText(delta) {
  if (delta === 0) return "平均每天时长不变";
  const direction = delta > 0 ? "增加" : "减少";
  const sign = delta > 0 ? "+" : "-";
  return `平均每天${direction}${minutes(Math.abs(delta))}（${sign}${decimalHours(delta)}h/天）`;
}

function targetGapText(average, target) {
  if (target === null) return "本月未设置每日目标。";
  const gap = average - target;
  if (gap === 0) return "假设后平均每天与每日目标持平。";
  return `假设后平均每天${gap > 0 ? "高于" : "低于"}每日目标${minutes(Math.abs(gap))}。`;
}

function simulateStudyDuration(result, simulation, selected, target, now) {
  const points = Array.isArray(result?.points) ? result.points : [];
  if (!points.length) throw new Error("统计结果缺少每日学习数据，暂时无法模拟");
  const currentTotal = CORE_SKILLS.reduce(
    (total, skill) => total + Math.max(0, Math.round(Number(result?.totals?.[skill] ?? 0))),
    0,
  );
  const currentDays = points.length;
  let assumedTotal = currentTotal;
  let assumedDays = currentDays;
  let assumption = "";
  if (simulation.kind === "future") {
    assumedTotal += simulation.days * simulation.dailyMinutes;
    assumedDays += simulation.days;
    assumption = `未来 ${simulation.days} 天每天学习${minutes(simulation.dailyMinutes)}`;
  } else if (simulation.day === "明天") {
    assumedTotal += simulation.finalMinutes;
    assumedDays += 1;
    assumption = `明天学习${minutes(simulation.finalMinutes)}`;
  } else {
    const date = simulation.day === "今天" ? selected.to : shiftDate(selected.to, -1);
    const point = points.find((item) => item?.label === date);
    if (!point) throw new Error(`${simulation.day}不在本月统计周期内，暂时无法模拟`);
    const existing = totalMinutes(point);
    assumedTotal += simulation.finalMinutes - existing;
    assumption = `${simulation.day}最终学习${minutes(simulation.finalMinutes)}`;
  }
  const currentAverage = Math.round(currentTotal / currentDays);
  const assumedAverage = Math.round(assumedTotal / assumedDays);
  const daysChange = assumedDays - currentDays;
  return [
    `学习时长假设模拟：${assumption}`,
    "基于本月真实记录计算，不会修改学习数据。",
    `平均每天：${minutes(currentAverage)} → ${minutes(assumedAverage)}`,
    averageChangeText(assumedAverage - currentAverage),
    `总学习时长：${minutes(currentTotal)} → ${minutes(assumedTotal)}`,
    `统计天数：${currentDays}天 → ${assumedDays}天${daysChange ? `（${daysChange > 0 ? "+" : ""}${daysChange}天）` : ""}`,
    targetGapText(assumedAverage, target),
  ].join("\n");
}

function shortError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Za-z]:[\\/][^\s"']+/gu, "<path>")
    .replace(/(token|secret|password|key)\s*[=:]\s*[^\s,;]+/giu, "$1=<redacted>")
    .replace(/\s+/gu, " ")
    .slice(0, 220);
}

function statisticsReply(result, label) {
  return result.inactivityWarning || "暂无间隔提醒。";
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
  return text === "/语言" || text === "/语言详细" || parseStudySimulation(text) !== null || parseDailyTarget(text) !== null || parseStatistics(text) !== null || parseKeywords(text) !== null;
}

export async function handle(message, context = {}) {
  const text = String(message ?? "").trim();
  if (text === "/语言" || text === "/语言详细") {
    return await context.renderPluginHelp?.("mashirobot-plugin-language", { detailed: text === "/语言详细" })
      ?? { handled: true, command: "语言学习帮助", reply: getHelp().fallbackText, mediaPaths: [] };
  }
  try {
    const runtime = runtimeFor(context);
    const simulation = parseStudySimulation(text);
    if (simulation) {
      if (simulation.error) return { handled: true, command: "学习时长假设模拟", reply: simulation.error, mediaPaths: [] };
      const selected = simulationRange(context.now ?? new Date());
      const [result, dailyTargetMinutes] = await Promise.all([
        runtime.runPlanner(["query-english-skills", "--from", selected.from, "--to", selected.to, "--granularity", selected.granularity]),
        readDailyTarget(runtime, selected),
      ]);
      return {
        handled: true,
        command: "学习时长假设模拟",
        reply: simulateStudyDuration(result, simulation, selected, dailyTargetMinutes, context.now ?? new Date()),
        mediaPaths: [],
      };
    }
    const targetCommand = parseDailyTarget(text);
    if (targetCommand) {
      if (targetCommand.error) return { handled: true, command: "设置英语学习目标", reply: targetCommand.error, mediaPaths: [] };
      const target = targetMonth(targetCommand, context.now ?? new Date());
      const saved = await runtime.runPlanner([
        "set-plugin-state", "--plugin-id", TARGET_PLUGIN_ID, "--state-key", monthKey(target.year, target.month),
        "--payload-base64", Buffer.from(JSON.stringify({ dailyMinutes: targetCommand.minutes }), "utf8").toString("base64"),
      ]);
      if (saved?.value?.dailyMinutes !== targetCommand.minutes) throw new Error("英语学习目标保存结果无法确认");
      return {
        handled: true,
        command: "设置英语学习目标",
        reply: "已设置 " + target.year + "年" + target.month + "月每日目标：" + minutes(targetCommand.minutes) + "。",
        mediaPaths: [],
      };
    }
    const keywordCommand = parseKeywords(text);
    if (keywordCommand) {
      const result = await runtime.runPlanner(["manage-english-keywords", "--action", keywordCommand.action, ...(keywordCommand.category ? ["--category", keywordCommand.category] : []), ...(keywordCommand.keyword ? ["--keyword", keywordCommand.keyword] : [])]);
      if (result?.changed && keywordCommand.action !== "list") context.undoManager?.record({
        scope: `${context.accountId ?? "global"}:${context.conversationId ?? "global"}`,
        owner: "mashirobot-plugin-language", actionKind: "english-keyword",
        description: `${keywordCommand.action === "add" ? "增加" : "删除"}英语关键词 ${keywordCommand.keyword}`,
        inversePayload: { action: keywordCommand.action === "add" ? "remove" : "add", category: keywordCommand.category, keyword: keywordCommand.keyword },
      });
      return { handled: true, command: keywordCommand.action === "list" ? "查看英语关键词" : "管理英语关键词", reply: keywordReply(result, keywordCommand), mediaPaths: [] };
    }
    const parsed = parseStatistics(text);
    if (!parsed) throw new Error("无法识别语言学习指令");
    const selected = range(parsed, context.now ?? new Date());
    const result = await runtime.runPlanner(["query-english-skills", "--from", selected.from, "--to", selected.to, "--granularity", selected.granularity]);
    const dailyTargetMinutes = await readDailyTarget(runtime, selected);
    if (dailyTargetMinutes !== null) result.dailyTargetMinutes = dailyTargetMinutes;
    let mediaPaths = [];
    let suffix = "";
    try {
      const cached = await runtime.generateEnglishSkillsChart(result);
      mediaPaths = runtime.copyChartForUse ? runtime.copyChartForUse([cached]) : [cached];
    } catch (error) {
      suffix = `\n\n图表生成失败：${shortError(error)}`;
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
  return { groups: [{ title: "英语统计", items: ["英语统计图：默认查看本周；也支持今天、昨天、周、月、年和具体日期", "学习时长假设：只计算假设对本月统计的影响，不修改数据", "英语关键词：查看、增加或删除统计关键词"] }], detailedGroups: [{ title: "统计指令", items: ["7月英语学习统计图", "本月目标时长：3h（也支持目标每天时长和小时）", "如果今天学习8h / 如果未来7天每天学习8h", "文字回复只显示间隔提醒，四项时长和目标对比显示在图片中"] }, { title: "关键词指令", items: ["英语关键词增加 阅读 上古卷轴5wiki", "英语关键词删除 阅读 上古卷轴5wiki", "新增或删除后会重算已有计划"] }], fallbackText: "英语统计图\n如果今天学习8h\n本月目标时长：3h\n英语关键词\n英语关键词增加 阅读 上古卷轴5wiki" };
}
