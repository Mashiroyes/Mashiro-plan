import { createPlanRuntime } from "../bridge/planner-runner.mjs";
import { resolveMessageDate } from "../shared/dates.mjs";

const PLAN_PERIOD_HEADINGS = new Set([
  "凌晨",
  "早上",
  "上午",
  "中午",
  "下午",
  "傍晚",
  "晚上",
  "夜间",
  "夜里",
]);

export function normalizePlanInput(rawText) {
  return String(rawText)
    .split(/\r?\n/)
    .filter((line) => !PLAN_PERIOD_HEADINGS.has(line.trim()))
    .join("\n");
}

export function firstLineIsPlanHeader(rawText) {
  const firstLine = normalizePlanInput(rawText)
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim()
    .replace(/\s+/g, "");
  return /^(?:今日|今天|明日|明天)?(?:的)?(?:计划|日程|安排)$/.test(firstLine ?? "");
}

function normalizePlanTitle(title) {
  return String(title)
    .replace(/^[\s\t　•\-—–*·、.。]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePlanItems(rawText) {
  const items = [];
  const pattern = /^\s*(?:[-*•]\s*)?(\d{1,2})\s*[:：]\s*(\d{1,2})\s*(?:-|—|–|~|～|至|到)\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s+(.+?)\s*$/;
  for (const rawLine of normalizePlanInput(rawText).split(/\r?\n/)) {
    const match = pattern.exec(rawLine.trim());
    if (!match) continue;
    const [startHour, startMinute, endHour, endMinute] = match.slice(1, 5).map(Number);
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) continue;
    const title = normalizePlanTitle(match[5]);
    if (!title) continue;
    items.push({
      startTime: `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`,
      endTime: `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
      title,
    });
  }
  return items;
}

export function parsePlanDate(rawText, now = new Date()) {
  const planText = normalizePlanInput(rawText);
  return resolveMessageDate(planText, now, { planHeader: firstLineIsPlanHeader(planText) });
}

export function looksLikePlanSave(rawText, items = parsePlanItems(rawText)) {
  return items.length > 0 && (
    firstLineIsPlanHeader(rawText) || /计划|新版|新版本|日程|安排/.test(String(rawText))
  );
}

export function looksLikePlanQuery(rawText) {
  const source = String(rawText);
  if (source.includes("\n")) return false;
  const text = source.trim().replace(/\s+/g, "");
  if (!/计划|日程|安排/.test(text)) return false;
  return /^(?:查询|查看|看看)?(?:(?:20\d{2}年)?\d{1,2}月\d{1,2}日|20\d{2}-\d{1,2}-\d{1,2}|昨天|今天|明天|今日)(?:的)?(?:计划|日程|安排)$/.test(text);
}

export function matchesPlan(rawText, context = {}) {
  const planText = normalizePlanInput(rawText);
  const planDate = parsePlanDate(planText, context.now);
  if (!planDate) return false;
  const items = parsePlanItems(planText);
  return looksLikePlanSave(planText, items) || looksLikePlanQuery(planText);
}

function formatPlanQuery(result) {
  const revisions = Array.isArray(result.revisions) ? result.revisions : [];
  const items = Array.isArray(result.currentItems) ? result.currentItems : [];
  if (!revisions.length) return `${result.planDate} 暂无计划记录。`;
  const latest = revisions.at(-1);
  const lines = items.map(
    (item) => `- ${item.start_time}${item.end_time ? `-${item.end_time}` : ""} ${item.title}`,
  );
  const history = revisions.length > 1
    ? `\n\n历史里还有 ${revisions.length - 1} 个旧版本；当前生效的是第 ${latest.revision_no} 版。`
    : "";
  if (!lines.length) return `${result.planDate} 有计划版本记录，但当前没有生效项目。${history}`;
  return `${result.planDate} 当前计划（第 ${latest.revision_no} 版）：\n\n${lines.join("\n")}${history}`;
}

function formatPlanSaveReply(result) {
  const items = Array.isArray(result.items) ? result.items : [];
  const scheduledCount = Array.isArray(result.scheduledTasks) ? result.scheduledTasks.length : 0;
  const immediateCount = Array.isArray(result.immediateItemIds) ? result.immediateItemIds.length : 0;
  const completedCount = Array.isArray(result.completedItemIds)
    ? result.completedItemIds.length
    : items.filter((item) => item.deliveryMode === "skip").length;
  const firstActive = items.find(
    (item) => item.deliveryMode === "immediate" || item.deliveryMode === "schedule",
  );
  const databaseVerified = result?.verifiedDatabase === true;
  if (!databaseVerified) {
    return "计划保存结果暂时无法确认。请先发送“查看今天计划”核对，不要立即重复提交。";
  }
  return [
    `已保存 ${result.planDate} 的完整计划，第 ${result.revisionNo} 版，共 ${items.length} 项。`,
    completedCount ? `录入时已结束的 ${completedCount} 项已自动记为 completed。` : null,
    result.verifiedTasks === true && scheduledCount ? `已安排 ${scheduledCount} 个一次性提醒。` : null,
    result.verifiedTasks !== true && (scheduledCount || result.partialFailure)
      ? `计划已保存，但提醒任务未确认${result.taskError ? `：${String(result.taskError).slice(0, 160)}` : "，请稍后查询计划状态"}。`
      : null,
    immediateCount ? `有 ${immediateCount} 项已到点，已立即提醒。` : null,
    firstActive
      ? `下一项：${firstActive.startTime}${firstActive.endTime ? `-${firstActive.endTime}` : ""} ${firstActive.title}`
      : null,
  ].filter(Boolean).join("\n");
}

function shortError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

export async function handlePlan(rawText, context = {}) {
  const planText = normalizePlanInput(rawText);
  const planDate = parsePlanDate(planText, context.now);
  if (!planDate) return null;
  const items = parsePlanItems(planText);
  const runtime = createPlanRuntime(context);
  if (looksLikePlanSave(planText, items)) {
    try {
      const result = await runtime.runManagePlan("SavePlan", {
        PayloadBase64: Buffer.from(
          JSON.stringify({ date: planDate, rawText: planText, items }),
          "utf8",
        ).toString("base64"),
      });
      return { command: "保存计划", reply: formatPlanSaveReply(result) };
    } catch (error) {
      if (error?.code === "PROCESS_TIMEOUT") {
        return { command: "保存计划", reply: `计划保存请求已超时，最终状态未知。请先发送“查看${planDate}计划”核对，不要立即重复提交。` };
      }
      return { command: "保存计划", reply: `本地计划保存失败：${shortError(error)}` };
    }
  }
  if (looksLikePlanQuery(planText)) {
    try {
      const result = await runtime.runPlanner(["query-date", "--date", planDate]);
      return { command: "查询计划", reply: formatPlanQuery(result) };
    } catch (error) {
      return { command: "查询计划", reply: `本地计划查询失败：${shortError(error)}` };
    }
  }
  return null;
}
