import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { dateFromParts, resolveMessageDate, shanghaiParts, shiftDate } from "../shared/dates.mjs";

function parseDurationMinutes(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, "");
  let match = /^(\d+(?:\.\d+)?)h$/i.exec(text);
  if (match) return Math.round(Number(match[1]) * 60);
  match = /^(\d+(?:\.\d+)?)(?:小时|时)$/.exec(text);
  if (match) return Math.round(Number(match[1]) * 60);
  match = /^(\d+)分(?:钟)?$/.exec(text);
  if (match) return Number(match[1]);
  match = /^(\d+(?:\.\d+)?)$/.exec(text);
  return match ? Math.round(Number(match[1]) * 60) : null;
}

function parseIntegerText(value) {
  const match = /(\d+)/.exec(String(value ?? "").replace(/[,\s，]/g, ""));
  return match ? Number(match[1]) : 0;
}

function parseReadingRange(line) {
  const match = /^(\d+)[-−—–~～到至](\d+)(?:=(\d+))?$/.exec(
    String(line ?? "").replace(/[,\s，]/g, ""),
  );
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const computed = Math.abs(first - second);
  return {
    start: Math.min(first, second),
    end: Math.max(first, second),
    words: computed || Number(match[3] ?? 0),
  };
}

function recordHeader(line) {
  return /^(?:(?:今日|今天|昨日|昨天|明日|明天)|(?:20\d{2}年)?\d{1,2}月\d{1,2}日|20\d{2}-\d{1,2}-\d{1,2})?(?:的)?(?:记录|复盘|统计)$/.test(
    String(line ?? "").trim().replace(/\s+/g, ""),
  );
}

export function parseDailyRecord(rawText, now = new Date(), dateOverride = null) {
  const lines = String(rawText).split(/\r?\n/);
  const firstLine = lines.find((line) => line.trim());
  if (!recordHeader(firstLine)) return null;
  let studyMinutes = 0;
  let entertainmentMinutes = 0;
  const other = [];
  let readingTitle = "";
  let readingWords = 0;
  let readingStartPos = null;
  let readingEndPos = null;
  let inOther = false;
  for (const rawLine of lines.slice(lines.indexOf(firstLine) + 1)) {
    const line = rawLine.replace(/^[\-*•○◦●\s]+/, "").trim();
    if (!line) continue;
    const range = parseReadingRange(line);
    if (range) {
      readingStartPos = range.start;
      readingEndPos = range.end;
      readingWords = range.words;
      continue;
    }
    if (/^其他\s*[:：]?\s*$/.test(line)) {
      inOther = true;
      continue;
    }
    const pair = /^(.+?)\s*[:：]\s*(.+)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].trim();
    const value = pair[2].trim();
    if (key === "学习") {
      studyMinutes = parseDurationMinutes(value) ?? studyMinutes;
      inOther = false;
      continue;
    }
    if (key === "娱乐") {
      entertainmentMinutes = parseDurationMinutes(value) ?? entertainmentMinutes;
      inOther = false;
      continue;
    }
    if (/字/.test(value) && !/^(学习|娱乐|其他)$/.test(key)) {
      readingTitle = key === "英文小说"
        ? value.replace(/[，,]?\s*\d[\d,\s，]*字.*$/, "").trim()
        : key;
      readingWords = parseIntegerText(value);
      inOther = false;
      continue;
    }
    const minutes = parseDurationMinutes(value);
    if (inOther || minutes !== null) other.push({ name: key, minutes: minutes ?? 0, raw: value });
  }
  return {
    date: dateOverride ?? resolveMessageDate(firstLine, now) ?? resolveMessageDate("今天", now),
    studyMinutes,
    entertainmentMinutes,
    other,
    readingTitle,
    readingWords,
    readingStartPos,
    readingEndPos,
    rawText: String(rawText),
  };
}

export function parseRecordQuery(rawText) {
  if (/\r?\n/.test(String(rawText).trim())) return null;
  let text = String(rawText).trim().replace(/\s+/g, "").replace(/^(?:查询|查看|看看|统计)/, "");
  if (!/(?:记录|复盘|统计)$/.test(text)) return null;
  const target = text.replace(/(?:的)?(?:记录|复盘|统计)$/, "");
  if (/^(?:今天|今日)$/.test(target)) return { kind: "day", relative: 0, label: "今天" };
  if (/^(?:昨天|昨日)$/.test(target)) return { kind: "day", relative: -1, label: "昨天" };
  let match = /^(20\d{2})-(\d{1,2})-(\d{1,2})$/.exec(target);
  if (match) return { kind: "day", dateParts: match.slice(1).map(Number), label: target };
  match = /^(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})日$/.exec(target);
  if (match) {
    return {
      kind: "day",
      dateParts: [match[1] ? Number(match[1]) : null, Number(match[2]), Number(match[3])],
      label: target,
    };
  }
  if (/^(?:本周|这周|这个星期|本星期|一周)$/.test(target)) return { kind: "week", offset: 0, label: "本周" };
  if (/^(?:上周|上个星期|上星期)$/.test(target)) return { kind: "week", offset: -1, label: "上周" };
  if (/^(?:本月|这个月|一月|一个月)$/.test(target)) return { kind: "month", offset: 0, label: "本月" };
  if (/^(?:上月|上个月)$/.test(target)) return { kind: "month", offset: -1, label: "上月" };
  match = /^(?:(20\d{2})年)?(\d{1,2})月$/.exec(target);
  if (match) return { kind: "month", year: match[1] ? Number(match[1]) : null, month: Number(match[2]), label: target };
  if (/^(?:今年|本年|一年)$/.test(target)) return { kind: "year", offset: 0, label: "今年" };
  if (/^(?:去年|上一年)$/.test(target)) return { kind: "year", offset: -1, label: "去年" };
  match = /^(20\d{2})年$/.exec(target);
  return match ? { kind: "year", year: Number(match[1]), label: target } : null;
}

function rangeForQuery(parsed, now) {
  const parts = shanghaiParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const currentYear = Number(parts.year);
  const currentMonth = Number(parts.month);
  if (parsed.kind === "day") {
    const date = parsed.dateParts
      ? dateFromParts(parsed.dateParts[0] ?? currentYear, parsed.dateParts[1], parsed.dateParts[2])
      : shiftDate(today, Number(parsed.relative ?? 0));
    if (!date) throw new Error("日期不存在，请使用例如“查询2026年8月1日记录”。");
    return { kind: "day", from: date, to: date, granularity: "day", label: parsed.label };
  }
  if (parsed.kind === "week") {
    const [year, month, day] = today.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    const monday = shiftDate(shiftDate(today, 1 - weekday), Number(parsed.offset ?? 0) * 7);
    const sunday = shiftDate(monday, 6);
    return { kind: "range", from: monday, to: sunday > today ? today : sunday, granularity: "day", label: parsed.label };
  }
  if (parsed.kind === "month") {
    let year = parsed.year ?? currentYear;
    let month = parsed.month ?? currentMonth;
    if (Number(parsed.offset ?? 0) === -1) {
      const previous = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
      year = previous.getUTCFullYear();
      month = previous.getUTCMonth() + 1;
    }
    const from = dateFromParts(year, month, 1);
    const naturalEnd = dateFromParts(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
    if (!from || !naturalEnd) throw new Error("月份不存在，请使用例如“查询2026年8月记录”。");
    if (from > today) throw new Error("未来月份还没有记录。");
    return { kind: "range", from, to: naturalEnd > today ? today : naturalEnd, granularity: "day", label: parsed.label };
  }
  const year = parsed.year ?? currentYear + Number(parsed.offset ?? 0);
  const from = dateFromParts(year, 1, 1);
  const naturalEnd = dateFromParts(year, 12, 31);
  if (!from || !naturalEnd) throw new Error("年份不存在，请使用例如“查询2026年记录”。");
  if (from > today) throw new Error("未来年份还没有记录。");
  return { kind: "range", from, to: naturalEnd > today ? today : naturalEnd, granularity: "month", label: parsed.label };
}

function formatDuration(minutes) {
  const value = Math.round(Number(minutes ?? 0));
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!hours) return `${rest}分钟`;
  return rest ? `${hours}小时${rest}分钟` : `${hours}小时`;
}

function formatSleepMinuteLabel(minutes) {
  if (minutes === null || minutes === undefined) return "暂无记录";
  const rounded = Math.round(Number(minutes));
  const wrapped = ((rounded % 1440) + 1440) % 1440;
  const clock = `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
  return rounded >= 1440 ? `次日 ${clock}` : clock;
}

function formatDailyRecordReply(result) {
  const other = Array.isArray(result.other) ? result.other : [];
  const otherLine = other.length
    ? `其他：${other.map((item) => `${item.name} ${Math.round(Number(item.minutes ?? 0) / 6) / 10}h`).join("，")}`
    : "其他：无";
  const range = result.readingStartPos !== null && result.readingEndPos !== null
    ? `（${result.readingStartPos}-${result.readingEndPos}）`
    : "";
  const reading = result.readingWords > 0
    ? `英文小说：${result.readingTitle || "未命名"} ${result.readingWords}字${range}`
    : "英文小说：0字";
  return [
    `已保存 ${result.date} 的今日记录。`,
    `学习：${Math.round(result.studyMinutes / 6) / 10}h`,
    `娱乐：${Math.round(result.entertainmentMinutes / 6) / 10}h`,
    otherLine,
    reading,
    result.sleep?.slept_at ? `睡觉时间：${String(result.sleep.slept_at).slice(11, 16)}` : "睡觉时间：暂无记录",
  ].join("\n");
}

function formatSingleRecordReply(result) {
  if (!result.row && !result.sleep) return `${result.date} 暂无记录。`;
  let other = [];
  try {
    const parsed = JSON.parse(String(result.row?.other_json ?? "[]"));
    if (Array.isArray(parsed)) other = parsed;
  } catch {
    // Corrupt optional details are represented as zero, matching the old route.
  }
  const otherMinutes = other.reduce((sum, item) => sum + Math.max(0, Number(item?.minutes ?? 0)), 0);
  const sleepMatch = /T(\d{2}):(\d{2})/.exec(String(result.sleep?.slept_at ?? ""));
  const sleepMinutes = sleepMatch
    ? (Number(sleepMatch[1]) < 6 ? Number(sleepMatch[1]) + 24 : Number(sleepMatch[1])) * 60 + Number(sleepMatch[2])
    : null;
  return [
    `${result.date} 的记录：`,
    `学习：${formatDuration(result.row?.study_minutes ?? 0)}`,
    `娱乐：${formatDuration(result.row?.entertainment_minutes ?? 0)}`,
    `其他：${formatDuration(otherMinutes)}（${other.length ? other.map((item) => `${item.name || "未命名"} ${formatDuration(item.minutes)}`).join("，") : "无"}）`,
    `英文小说：${Number(result.row?.reading_words ?? 0) > 0 ? `${result.row?.reading_title || "未命名英文小说"} ${Number(result.row.reading_words)}字` : "0字"}`,
    `睡觉时间：${formatSleepMinuteLabel(sleepMinutes)}`,
  ].join("\n");
}

function formatRecordRangeReply(result, label) {
  const warning = Array.isArray(result.warnings) && result.warnings.length
    ? `\n数据提示：${result.warnings.join("；")}`
    : "";
  return [
    `${label}记录（${result.fromDate} 至 ${result.toDate}）：`,
    `有日常记录：${result.recordedDays}天；有睡觉记录：${result.sleepDays}天`,
    `学习合计：${formatDuration(result.totals?.studyMinutes)}`,
    `娱乐合计：${formatDuration(result.totals?.entertainmentMinutes)}`,
    `其他合计：${formatDuration(result.totals?.otherMinutes)}`,
    `英文小说合计：${Number(result.totals?.readingWords ?? 0)}字`,
    `平均睡觉时间：${formatSleepMinuteLabel(result.averageSleepMinutes)}`,
  ].join("\n") + warning;
}

function shortError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

export function matchesRecord(rawText, context = {}) {
  return Boolean(parseRecordQuery(rawText) || parseDailyRecord(rawText, context.now));
}

export async function handleRecord(rawText, context = {}) {
  const runtime = createPlanRuntime(context);
  const query = parseRecordQuery(rawText);
  if (query) {
    try {
      const range = rangeForQuery(query, context.now ?? new Date());
      if (range.kind === "day") {
        const result = await runtime.runPlanner(["query-daily-record", "--date", range.from]);
        return { command: "查询单日记录", reply: formatSingleRecordReply(result) };
      }
      const result = await runtime.runPlanner([
        "query-record-range",
        "--from",
        range.from,
        "--to",
        range.to,
        "--granularity",
        range.granularity,
      ]);
      let mediaPaths = [];
      let chartNote = "";
      try {
        const cached = await runtime.generateRecordChart(result);
        mediaPaths = runtime.copyChartForUse ? runtime.copyChartForUse([cached]) : [cached];
      } catch (error) {
        chartNote = `\n\n图表生成失败，文字统计仍然有效：${shortError(error).slice(0, 160)}`;
      }
      return {
        command: "查询范围记录",
        reply: formatRecordRangeReply(result, range.label) + chartNote,
        mediaPaths,
      };
    } catch (error) {
      return { command: "查询记录", reply: `本地记录查询失败：${shortError(error)}` };
    }
  }
  const payload = parseDailyRecord(rawText, context.now, context.recordDateOverride);
  if (!payload) return null;
  try {
    const result = await runtime.runPlanner([
      "save-daily-record",
      "--payload-base64",
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    ]);
    return { command: "保存今日记录", reply: formatDailyRecordReply(result) };
  } catch (error) {
    return { command: "保存今日记录", reply: `本地今日记录保存失败：${shortError(error)}` };
  }
}

export function splitPlanAndDailyRecord(rawText) {
  const lines = String(rawText).split(/\r?\n/);
  const normalized = lines.map((line) => line.trim().replace(/\s+/g, ""));
  const planIndex = normalized.findIndex((line) => /^(?:(?:今日|今天|明日|明天)?(?:的)?|(?:20\d{2}年)?\d{1,2}月\d{1,2}日(?:的)?|20\d{2}-\d{1,2}-\d{1,2}(?:的)?)(?:新版|新版本)?(?:计划|日程|安排)$/.test(line));
  const recordIndex = normalized.findIndex((line) => recordHeader(line));
  if (planIndex < 0 || recordIndex < 0 || planIndex === recordIndex) return null;
  const section = (start, end) => lines.slice(start, end > start ? end : lines.length).join("\n").trim();
  return { planText: section(planIndex, recordIndex), recordText: section(recordIndex, planIndex) };
}
