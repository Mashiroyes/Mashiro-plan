import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { dateFromParts, formatClock, shanghaiParts, shiftDate } from "../shared/dates.mjs";

export function parseSleepQuery(rawText, now = new Date()) {
  const text = String(rawText).trim().replace(/\s+/g, "");
  if (!/睡觉时间/.test(text)) return null;
  if (/(?:20\d{2}年)?\d{1,2}月\d{1,2}日/.test(text) || /睡觉时间.*\d{1,2}[:：]\d{2}$/.test(text)) return null;
  const explicitRange = /(?:上个星期|上星期|上周|这个星期|这星期|本周)/.test(text)
    || /(?:(?:20\d{2})年)?(?:1[0-2]|0?[1-9])月/.test(text);
  if (!/(?:查询|查看|看看|统计)/.test(text) && !explicitRange) return null;
  const parts = shanghaiParts(now);
  const currentDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (/(?:上个星期|上星期|上周)/.test(text)) {
    const [year, month, day] = currentDate.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    const monday = shiftDate(currentDate, 1 - weekday);
    return { from: shiftDate(monday, -7), to: shiftDate(monday, -1), label: "上个星期" };
  }
  if (/(?:这个星期|这星期|本周)/.test(text)) {
    const [year, month, day] = currentDate.split("-").map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    const monday = shiftDate(currentDate, 1 - weekday);
    return { from: monday, to: shiftDate(monday, 6), label: "这个星期" };
  }
  const monthMatch = /(?:(20\d{2})年)?(1[0-2]|0?[1-9])月/.exec(text);
  if (!monthMatch) return null;
  const year = monthMatch[1] ? Number(monthMatch[1]) : Number(parts.year);
  const month = Number(monthMatch[2]);
  const from = dateFromParts(year, month, 1);
  const to = dateFromParts(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
  return from && to ? { from, to, label: `${year}年${month}月` } : null;
}

function formatSleepQuery(range, result) {
  const rows = Array.isArray(result.rows) ? result.rows : [];
  if (!rows.length) return `${range.label}暂无睡觉时间记录。`;
  const values = rows.map((row) => {
    const parts = shanghaiParts(new Date(row.slept_at));
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    return {
      line: `${Number(row.routine_date.slice(5, 7))}月${Number(row.routine_date.slice(8, 10))}日  ${parts.hour}:${parts.minute}`,
      minutes: (hour < 12 ? hour + 24 : hour) * 60 + minute,
    };
  });
  const average = values.reduce((sum, value) => sum + value.minutes, 0) / values.length;
  const minimum = Math.min(...values.map((value) => value.minutes));
  const maximum = Math.max(...values.map((value) => value.minutes));
  return `${values.map((value) => value.line).join("\n")}\n\n有记录 ${values.length} 天，平均 ${formatClock(average)}，最早 ${formatClock(minimum)}，最晚 ${formatClock(maximum)}`;
}

export async function handleSleepQuery(rawText, context = {}) {
  const range = parseSleepQuery(rawText, context.now);
  if (!range) return null;
  try {
    const result = await createPlanRuntime(context).runPlanner([
      "query-sleep",
      "--from",
      range.from,
      "--to",
      range.to,
    ]);
    return { command: "查询睡觉时间", reply: formatSleepQuery(range, result) };
  } catch {
    return { command: "查询睡觉时间", reply: "本地睡觉时间查询失败，请稍后再试。" };
  }
}
