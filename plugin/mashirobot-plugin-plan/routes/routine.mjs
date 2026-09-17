import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { currentRoutineDate, shanghaiDate, shanghaiIso } from "../shared/dates.mjs";

export const ROUTINE_KEYWORDS = new Set([
  "没打卡",
  "已打卡",
  "已睡觉",
  "已起床",
]);

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
  if (!ROUTINE_KEYWORDS.has(command)) return null;
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
