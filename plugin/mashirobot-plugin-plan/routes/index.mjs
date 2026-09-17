import { handlePlan, matchesPlan, parsePlanDate } from "./plan.mjs";
import { handleRecord, matchesRecord, splitPlanAndDailyRecord } from "./record.mjs";
import { handleReminder, matchesReminder } from "./reminder.mjs";
import { handleRoutine, ROUTINE_KEYWORDS } from "./routine.mjs";
import { handleSleepQuery, parseSleepQuery } from "./sleep.mjs";
import { handleWakeup, matchesWakeup } from "./wakeup.mjs";

async function handleCombined(rawText, context) {
  const sections = splitPlanAndDailyRecord(rawText);
  if (!sections) return null;
  const planResult = await handlePlan(sections.planText, context);
  const recordDateOverride = parsePlanDate(sections.planText, context.now);
  const recordResult = await handleRecord(sections.recordText, { ...context, recordDateOverride });
  return {
    command: "保存计划和今日记录",
    reply: [
      planResult?.reply || "计划部分未能识别，请检查时间段格式。",
      recordResult?.reply || "记录部分未能识别，请检查字段格式。",
    ].join("\n\n"),
  };
}

/** Pure matcher: parsing is allowed; process, database, and filesystem access are not. */
export function matchPlanPlugin(message, context = {}) {
  const text = String(message).trim();
  if (matchesReminder(text, context)) return true;
  if (splitPlanAndDailyRecord(text)) return true;
  if (matchesRecord(text, context)) return true;
  if (matchesPlan(text, context)) return true;
  if (ROUTINE_KEYWORDS.has(text)) return true;
  if (matchesWakeup(text, context)) return true;
  return parseSleepQuery(text, context.now) !== null;
}

/** Execute the first matching local route in the same order as the old fast entry. */
export async function handlePlanPlugin(message, context = {}) {
  const text = String(message).trim();
  const handlers = [
    () => handleReminder(text, context),
    () => handleCombined(text, context),
    () => handleRecord(text, context),
    () => handlePlan(text, context),
    () => handleRoutine(text, context),
    () => handleWakeup(text, context),
    () => handleSleepQuery(text, context),
  ];
  for (const invoke of handlers) {
    const result = await invoke();
    if (result) return result;
  }
  return null;
}
