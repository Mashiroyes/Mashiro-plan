import {
  isReminderAcknowledgement,
  matchPauseReminderCommand,
} from "../contracts/reserved-commands.mjs";

function result(command, reply) { return { handled: true, command, reply, mediaPaths: [] }; }

export function createSystemCommandRouter({ reminderManager, inspectDatabase, undoManager, currentTasks, diagnostics, onAcknowledge = async () => {} }) {
  return async function routeSystemCommand(rawText, context = {}) {
    const text = String(rawText ?? "").trim();
    const pause = matchPauseReminderCommand(text);
    if (pause) {
      const state = reminderManager.pause(Number(pause[1]));
      return result("暂停提醒", `普通提醒已暂停至 ${new Date(state.pausedUntil).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}。起床闹钟仍会发送。`);
    }
    if (text === "今晚静默") { reminderManager.silenceTonight(); return result("今晚静默", "今晚的普通提醒已静默；起床闹钟仍会发送。"); }
    if (text === "恢复提醒") { reminderManager.resume(); return result("恢复提醒", "普通提醒已恢复。"); }
    if (text === "查看当前提醒") {
      const rows = reminderManager.listCurrent();
      return result("查看当前提醒", rows.length ? rows.map((row) => `${row.shortId} ${row.content}（${row.status}）`).join("\n") : "当前没有活动提醒。");
    }
    if (isReminderAcknowledgement(text)) {
      const value = reminderManager.acknowledge(text);
      if (value.status === "none") return result("确认提醒", "当前没有等待确认的提醒。");
      if (value.status === "ambiguous") return result("确认提醒", `现在有 ${value.reminders.length} 个待确认提醒，请使用“收到 R编号”：\n${value.reminders.map((row) => `${row.shortId} ${row.content}`).join("\n")}`);
      if (value.status === "not-found") return result("确认提醒", `没有找到该提醒。当前可确认：${value.reminders.map((row) => row.shortId).join("、")}`);
      const cleanup = await onAcknowledge(value.reminder);
      const suffix = cleanup?.cleanupPending
        ? " Windows 任务尚未清理，将由系统对账重试。"
        : "";
      return result("确认提醒", `已确认 ${value.reminder.shortId}。${suffix}`);
    }
    if (text === "数据库自检") {
      const health = inspectDatabase();
      return result("数据库自检", [health.ok ? "数据库状态正常。" : "数据库发现异常。", `完整性：${health.integrity}`, `外键异常：${health.foreignKeyViolations}`, `迁移版本：${health.migrationVersion}`, `最近备份：${health.latestBackup ?? "尚无"}`, `操作冲突：${health.operationConflicts}`].join("\n"));
    }
    if (text === "撤销上一操作") {
      const scope = `${context.accountId ?? "global"}:${context.conversationId ?? "global"}`;
      const value = await undoManager?.undoLatest(scope);
      if (!value || value.status === "none") return result("撤销上一操作", "没有可撤销的上一操作。");
      if (value.status === "undone") return result("撤销上一操作", `已撤销：${value.description}。`);
      if (value.status === "recovery") return result("撤销上一操作", `“${value.description}”不能安全地自动撤销。请使用恢复流程：${value.recoveryCommand ?? "查看自检结果"}。`);
      return result("撤销上一操作", `未能撤销“${value.description}”，状态已保留，可以稍后重试。`);
    }
    if (text === "当前任务") return result("当前任务", await currentTasks());
    if (text === "自检") return result("系统自检", await diagnostics());
    return null;
  };
}
