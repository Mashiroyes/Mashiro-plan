import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { currentRoutineDate, shanghaiDate, shanghaiIso, shiftDate } from "../shared/dates.mjs";

export const ROUTINE_KEYWORDS = new Set([
  "没打卡",
  "已打卡",
  "已睡觉",
  "已起床",
]);

const DEFER_SLEEP_REMINDER = /^睡觉时间延迟到\s*(\d{1,2})点\s*(\d{1,2})分$/;
const SLEEP_CONTROL = new Set(["今晚不再提醒", "延迟30分钟"]);

export function matchesRoutine(rawText) {
  const command = String(rawText).trim();
  return ROUTINE_KEYWORDS.has(command) || SLEEP_CONTROL.has(command) || DEFER_SLEEP_REMINDER.test(command);
}

function parseDeferredSleepReminder(command, now, routineDate) {
  const match = DEFER_SLEEP_REMINDER.exec(command);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { error: "时间格式不对，请按“睡觉时间延迟到23点30分”回复。" };

  const today = shanghaiDate(now);
  let date = today;
  let deferredUntil = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
  if (deferredUntil.getTime() <= now.getTime()) {
    date = shiftDate(date, 1);
    deferredUntil = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
  }
  const reminderWindowEnd = new Date(`${shiftDate(routineDate, 1)}T02:50:00+08:00`);
  if (deferredUntil.getTime() > reminderWindowEnd.getTime()) {
    return { error: "只能延迟到本轮睡觉提醒结束前的时间（最晚次日2点50分）。" };
  }
  return { deferredUntil, label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function payloadBase64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function state(runtime, stateKey) {
  const result = await runtime.runPlanner([
    "get-plugin-state",
    "--plugin-id",
    "mashirobot-plugin-plan",
    "--state-key",
    stateKey,
  ]);
  return result?.found ? result.value : null;
}

async function setState(runtime, stateKey, value) {
  return runtime.runPlanner([
    "set-plugin-state",
    "--plugin-id",
    "mashirobot-plugin-plan",
    "--state-key",
    stateKey,
    "--payload-base64",
    payloadBase64(value),
  ]);
}

function shortError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 220);
}

export async function handleRoutine(rawText, context = {}) {
  const command = String(rawText).trim();
  if (!matchesRoutine(command)) return null;
  const runtime = createPlanRuntime(context);
  const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
  const updatedAt = shanghaiIso(now);

  if (command === "已起床") {
    try {
      const wake = await state(runtime, "wakeup:active");
      if (!wake || wake.active !== true) {
        return {
          command,
          reply: "收到。当前没有正在进行的起床提醒；如果之前还有提醒弹出，请再发“查询起床提醒”确认。",
        };
      }
      const canceled = await runtime.runRoutineAction("CancelWakeup");
      context.reminderManager?.cancelBySource("mashirobot-plugin-plan", String(wake.windowsTaskName ?? ""), "wakeup");
      if (canceled?.verifiedDatabase === true && canceled?.verifiedTasks === true) {
        return { command, reply: "收到，已停止起床提醒。网易云和系统音量保持不变。" };
      }
      return { command, reply: "已记录停止请求，但起床提醒的系统任务尚未完全确认删除；请发送“查询起床提醒”核对。" };
    } catch (error) {
      return { command, reply: `本地起床任务处理失败：${shortError(error)}` };
    }
  }

  const routineDate = currentRoutineDate(now);
  const stateKey = `night:${routineDate}`;
  let current;
  try {
    current = await state(runtime, stateKey);
  } catch (error) {
    return { command, reply: `本地晚间状态读取失败：${shortError(error)}` };
  }

  if (command === "今晚不再提醒") {
    if (!current || current.routineDate !== routineDate || current.slept) return { command, reply: "当前没有正在进行的睡觉提醒。" };
    await setState(runtime, stateKey, { ...current, dismissed: true, remindAfter: null, updatedAt });
    context.reminderManager?.cancelBySource("mashirobot-plugin-plan", routineDate, "sleep");
    return { command, reply: "收到，今晚不再提醒睡觉；明晚会恢复正常。" };
  }

  if (command === "延迟30分钟") {
    if (!current || current.routineDate !== routineDate || current.slept) return { command, reply: "当前没有正在进行的睡觉提醒。" };
    const deferredUntil = new Date(now.getTime() + 30 * 60_000);
    const scheduled = await runtime.runRoutineAction("SetDeferredNightReminder", { StartAt: shanghaiIso(deferredUntil), TaskName: `MashiroBot-NightDeferred-${routineDate}` });
    if (scheduled?.verifiedTasks !== true) return { command, reply: "延迟任务未能确认设置，原来的提醒会继续。" };
    await setState(runtime, stateKey, { ...current, dismissed: false, remindAfter: shanghaiIso(deferredUntil), updatedAt });
    return { command, reply: `收到，30分钟内不再提醒；${shanghaiIso(deferredUntil).slice(11, 16)} 后继续。` };
  }

  const deferred = parseDeferredSleepReminder(command, now, routineDate);
  if (deferred) {
    if (deferred.error) return { command, reply: deferred.error };
    if (!current || current.routineDate !== routineDate || current.slept) {
      return { command, reply: "收到。当前没有正在进行的睡觉催促，暂时不能设置延迟。" };
    }
    const next = {
      ...current,
      routineDate,
      slept: false,
      remindAfter: shanghaiIso(deferred.deferredUntil),
      updatedAt,
    };
    try {
      const scheduled = await runtime.runRoutineAction("SetDeferredNightReminder", {
        StartAt: shanghaiIso(deferred.deferredUntil),
        TaskName: `MashiroBot-NightDeferred-${routineDate}`,
      });
      if (scheduled?.verifiedTasks !== true) {
        return { command, reply: "延迟睡觉提醒的定时任务未能确认设置，原来的提醒会继续。" };
      }
      await setState(runtime, stateKey, next);
      return { command, reply: `收到，在 ${deferred.label} 前不再提醒；到时间后会继续提醒你睡觉。` };
    } catch (error) {
      return { command, reply: `本地晚间状态保存失败：${shortError(error)}` };
    }
  }

  if (command === "已睡觉") {
    try {
      const sleep = await runtime.runPlanner([
        "record-sleep",
        "--date",
        routineDate,
        "--slept-at",
        updatedAt,
      ]);
      await setState(runtime, `night:${sleep.routineDate}`, {
        ...(current && typeof current === "object" ? current : {}),
        routineDate: sleep.routineDate,
        wordChecked: Boolean(current?.wordChecked),
        slept: true,
        updatedAt,
      });
      context.reminderManager?.cancelBySource("mashirobot-plugin-plan", sleep.routineDate, "sleep");
      const reply = current
        ? `收到，已记录睡觉时间 ${updatedAt.slice(11, 16)}，今晚的催促已停止。晚安。`
        : `收到，已记录睡觉时间 ${updatedAt.slice(11, 16)}，并已停止当前睡觉催促。`;
      return { command, reply };
    } catch {
      return { command, reply: "本地睡觉时间记录失败，请稍后再试。" };
    }
  }

  if (!current || current.routineDate !== routineDate) {
    return {
      command,
      reply: command === "已打卡"
        ? "收到，已记录你的回复。当前没有正在运行的晚间打卡催促任务。"
        : "收到。当前没有正在运行的晚间打卡催促任务。",
    };
  }

  const next = {
    ...current,
    routineDate,
    wordChecked: command === "已打卡",
    slept: false,
    updatedAt,
  };
  try {
    await setState(runtime, stateKey, next);
  } catch (error) {
    return { command, reply: `本地晚间状态保存失败：${shortError(error)}` };
  }
  if (command === "没打卡") return { command, reply: "收到，打完后回复“已打卡”。" };
  return {
    command,
    reply: "收到，已记录单词打卡完成。接下来可以准备睡觉了，睡下后回复“已睡觉”。",
  };
}
