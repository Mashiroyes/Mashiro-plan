import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { dateFromParts, shanghaiParts, shiftDate } from "../shared/dates.mjs";

function parseDate(text, now) {
  const current = shanghaiParts(now);
  const currentDate = `${current.year}-${current.month}-${current.day}`;
  let match = /(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) {
    const date = dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    return date ? { date } : { error: "日期不存在，请重新指定。" };
  }
  match = /(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(text);
  if (match) {
    const date = dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    return date ? { date } : { error: "日期不存在，请重新指定。" };
  }
  match = /(\d{1,2})月\s*(\d{1,2})日/.exec(text);
  if (match) {
    const date = dateFromParts(Number(current.year), Number(match[1]), Number(match[2]));
    if (!date) return { error: "日期不存在，请重新指定。" };
    if (date < currentDate) return { error: "这个日期在今年已经过去，请明确写出年份。" };
    return { date };
  }
  if (text.includes("后天")) return { date: shiftDate(currentDate, 2) };
  if (text.includes("明天") || text.includes("明早") || text.includes("明晚")) return { date: shiftDate(currentDate, 1) };
  if (text.includes("今天") || text.includes("今晚") || text.includes("今早")) return { date: currentDate };
  return { error: "请补充日期，例如“明天早上 7 点喊我起床”。" };
}

function parseTime(text) {
  const period = /(凌晨|早上|上午|中午|下午|晚上|夜里)/.exec(text)?.[1] ?? "";
  let hour;
  let minute;
  const colon = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(text);
  if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  } else {
    const point = /(\d{1,2})\s*点(?:\s*(半)|(\d{1,2})\s*分?)?/.exec(text);
    if (!point) return { error: "请补充具体时间，例如“明天早上 7 点喊我起床”。" };
    hour = Number(point[1]);
    minute = point[2] ? 30 : Number(point[3] ?? 0);
  }
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return { error: "时间格式不正确，请重新指定。" };
  if (["下午", "晚上", "夜里"].includes(period) && hour >= 1 && hour <= 11) hour += 12;
  if (period === "中午" && hour >= 1 && hour <= 10) hour += 12;
  if (period === "凌晨" && hour === 12) hour = 0;
  if (["早上", "上午"].includes(period) && hour > 12) return { error: "上午时间格式不正确，请重新指定。" };
  return { hour, minute };
}

export function parseWakeRequest(rawText, now = new Date()) {
  const text = String(rawText).trim().replace(/\s+/g, " ");
  if (!text) return { kind: "none" };
  if (/(?:取消|删除|去掉|关掉|停止).{0,10}(?:起床|起床提醒|起床任务|起床闹钟)/.test(text)) {
    return { kind: "cancel" };
  }
  if (/(?:查看|查询|看看).{0,10}(?:起床|起床提醒|起床闹钟)/.test(text)
      || /起床(?:提醒|闹钟).{0,10}(?:几点|什么时候|状态)/.test(text)) {
    return { kind: "query" };
  }
  const setIntent = text.includes("起床")
    && /(?:喊|叫|叫醒|提醒).{0,4}(?:我)?起床|(?:设置|设|加).{0,10}(?:起床|闹钟)|起床(?:提醒|闹钟)/.test(text);
  if (!setIntent) return { kind: "none" };
  const parsedDate = parseDate(text, now);
  if (!parsedDate.date) return { kind: "error", reply: parsedDate.error };
  const parsedTime = parseTime(text);
  if (parsedTime.hour === undefined || parsedTime.minute === undefined) {
    return { kind: "error", reply: parsedTime.error };
  }
  const clock = `${String(parsedTime.hour).padStart(2, "0")}:${String(parsedTime.minute).padStart(2, "0")}`;
  const startAt = `${parsedDate.date}T${clock}:00+08:00`;
  if (Date.parse(startAt) <= new Date(now).getTime()) {
    return { kind: "error", reply: "这个起床时间已经过去，请重新指定未来时间。" };
  }
  return { kind: "set", startAt };
}

export function matchesWakeup(rawText, context = {}) {
  return parseWakeRequest(rawText, context.now).kind !== "none";
}

function outputText(value) {
  if (value && typeof value === "object" && typeof value.message === "string") return value.message;
  if (typeof value === "string") return value;
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function changeReply(result, action) {
  if (result?.verifiedDatabase === true && result?.verifiedTasks === true) return outputText(result);
  if (result?.verifiedDatabase === true) {
    return `${action === "set" ? "起床时间已保存" : "取消状态已保存"}，但 Windows 起床任务${action === "set" ? "尚未确认创建" : "尚未确认删除"}。请发送“查询起床提醒”核对，不要立即重复操作。`;
  }
  return `${action === "set" ? "设置" : "取消"}结果暂时无法确认。请发送“查询起床提醒”核对，不要立即重复操作。`;
}

export async function handleWakeup(rawText, context = {}) {
  const parsed = parseWakeRequest(rawText, context.now);
  if (parsed.kind === "none") return null;
  if (parsed.kind === "error") return { command: "设置起床提醒", reply: parsed.reply };
  const runtime = createPlanRuntime(context);
  try {
    if (parsed.kind === "set") {
      const result = await runtime.runRoutineAction("SetWakeup", { StartAt: parsed.startAt });
      return {
        command: "设置起床提醒",
        reply: changeReply(result, "set"),
      };
    }
    if (parsed.kind === "cancel") {
      const result = await runtime.runRoutineAction("CancelWakeup");
      return {
        command: "取消起床提醒",
        reply: changeReply(result, "cancel"),
      };
    }
    const result = await runtime.runRoutineAction("GetWakeup");
    return {
      command: "查询起床提醒",
      reply: outputText(result),
    };
  } catch (error) {
    if (error?.code === "PROCESS_TIMEOUT") {
      return { command: parsed.kind === "cancel" ? "取消起床提醒" : "设置起床提醒", reply: "起床提醒操作已超时，最终状态未知。请发送“查询起床提醒”核对，不要立即重复操作。" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { command: "设置起床提醒", reply: `本地起床任务处理失败：${message.slice(0, 300)}` };
  }
}
