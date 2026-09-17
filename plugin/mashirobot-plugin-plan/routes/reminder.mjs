import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { dateFromParts, shanghaiParts, shiftDate } from "../shared/dates.mjs";

export function parseGeneralReminder(rawText, now = new Date()) {
  const raw = String(rawText).trim();
  const opening = /^提醒我\s*/.exec(raw);
  const timeFirst = /^(?:(\d{1,2})点(?:(\d{1,2})分)?|(\d{1,2}):(\d{1,2}))\s*提醒我\s*/.exec(raw);
  if (!opening && !timeFirst) return null;
  let rest = opening ? raw.slice(opening[0].length).trim() : raw.slice(timeFirst[0].length).trim();
  const current = shanghaiParts(now);
  const today = `${current.year}-${current.month}-${current.day}`;
  let reminderDate = today;
  let dateMatch = /^(今天|明天)\s*/.exec(rest);
  if (dateMatch) {
    reminderDate = dateMatch[1] === "明天" ? shiftDate(today, 1) : today;
    rest = rest.slice(dateMatch[0].length);
  } else {
    dateMatch = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*/.exec(rest);
    if (dateMatch) {
      reminderDate = dateFromParts(
        Number(dateMatch[1] || current.year),
        Number(dateMatch[2]),
        Number(dateMatch[3]),
      );
      if (!reminderDate) return { error: "日期不存在，请使用真实的日历日期。" };
      rest = rest.slice(dateMatch[0].length);
    }
  }
  const periodMatch = opening ? /^(上午|中午|下午|晚上|凌晨)\s*/.exec(rest) : null;
  const period = periodMatch?.[1] ?? null;
  if (periodMatch) rest = rest.slice(periodMatch[0].length);
  const timeMatch = opening ? /^(?:(\d{1,2})点(?:(\d{1,2})分)?|(\d{1,2}):(\d{1,2}))\s*/.exec(rest) : timeFirst;
  if (!timeMatch) return { error: "无法识别提醒时间，请使用例如“明天12点”或“8月5日12:30”。" };
  let hour = Number(timeMatch[1] ?? timeMatch[3]);
  const minute = Number(timeMatch[2] ?? timeMatch[4] ?? 0);
  if (minute < 0 || minute > 59) return { error: "提醒分钟必须在 00 到 59 之间。" };
  if (period) {
    if (hour < 1 || hour > 12) return { error: `${period}时间的小时必须在 1 到 12 之间。` };
    if ((period === "下午" || period === "晚上") && hour <= 11) hour += 12;
    else if (period === "中午" && hour <= 10) hour += 12;
    else if (period === "凌晨" && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return { error: "提醒小时必须在 0 到 23 之间。" };
  }
  if (opening) rest = rest.slice(timeMatch[0].length);
  const content = rest.replace(/^[\s,，:：。]+/, "").trim();
  if (!content) return { error: "提醒内容不能为空，请在时间后写明要提醒的事情。" };
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const startAt = `${reminderDate}T${clock}:00+08:00`;
  if (Date.parse(startAt) <= new Date(now).getTime()) {
    const label = reminderDate === today ? `今天 ${clock}` : `${reminderDate} ${clock}`;
    return { error: `${label} 已经过了，请改成未来时间。` };
  }
  return { content, startAt };
}

export function matchesReminder(rawText, context = {}) {
  const text = String(rawText).trim();
  return text === "收到" || parseGeneralReminder(rawText, context.now) !== null;
}

function shortError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

export async function handleReminder(rawText, context = {}) {
  const command = String(rawText).trim();
  const runtime = createPlanRuntime(context);
  if (command === "收到") {
    try {
      const acknowledged = await runtime.runPlanner(["ack-latest-general-reminder"]);
      if (!acknowledged?.found) {
        return { command: "确认通用提醒", reply: "当前没有等待确认的提醒。" };
      }
      const removed = await runtime.removeScheduledTask(acknowledged.taskName);
      return {
        command: "确认通用提醒",
        reply: removed
          ? `收到，已停止“${acknowledged.content}”的后续提醒。`
          : `收到，数据库已记录“${acknowledged.content}”为已确认，但 Windows 提醒任务的删除尚未确认；若仍弹出，请查询提醒状态。`,
      };
    } catch (error) {
      return { command: "确认通用提醒", reply: `本地提醒确认失败：${shortError(error)}` };
    }
  }
  const parsed = parseGeneralReminder(rawText, context.now);
  if (!parsed) return null;
  if (parsed.error) return { command: "设置通用提醒", reply: parsed.error };
  try {
    const result = await runtime.runRoutineAction("SetGeneralReminder", {
      StartAt: parsed.startAt,
      Message: parsed.content,
    });
    if (result?.verifiedDatabase === true && result?.verifiedTasks === true) {
      return {
        command: "设置通用提醒",
        reply: `已设置：${parsed.startAt.slice(0, 10)} ${parsed.startAt.slice(11, 16)} 提醒你${parsed.content}。未回复“收到”时每 5 分钟提醒一次。`,
      };
    }
    if (result?.verifiedDatabase === true) {
      return {
        command: "设置通用提醒",
        reply: `提醒内容已保存，但 Windows 提醒任务未确认${result.taskError ? `：${String(result.taskError).slice(0, 160)}` : ""}。请先查询提醒状态，不要立即重复设置。`,
      };
    }
    return {
      command: "设置通用提醒",
      reply: "提醒创建结果暂时无法确认。请先查询提醒状态，不要立即重复设置。",
    };
  } catch (error) {
    if (error?.code === "PROCESS_TIMEOUT") {
      return { command: "设置通用提醒", reply: "提醒创建请求已超时，最终状态未知。请先查询提醒状态，不要立即重复设置。" };
    }
    return { command: "设置通用提醒", reply: `本地提醒创建失败：${shortError(error)}` };
  }
}
