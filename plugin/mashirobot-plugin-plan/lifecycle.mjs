import path from "node:path";
import { openControlDatabase } from "../../core/control/database.mjs";

function missingTask(error) {
  const detail = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  return /cannot find|not found|找不到指定的文件|系统找不到/iu.test(detail);
}

export function registerPlanLifecycle({
  undoManager,
  lifecycleHooks,
  sqlitePath,
  pluginRoot,
  runLocalProcess,
  logger,
  clock,
}) {
  const run = (options) => runLocalProcess({ pluginId: "mashirobot-plugin-plan", logger, ...options });
  const deleteTask = async (taskName) => {
    try {
      await run({
        executable: "schtasks.exe",
        args: ["/Delete", "/TN", taskName, "/F"],
        timeoutProfile: "schtasks",
        operation: "plan-delete-scheduled-task",
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
    } catch (error) {
      if (!missingTask(error)) throw error;
    }
  };

  undoManager.register("general-reminder", async ({ reminderId, taskName }) => {
    const db = openControlDatabase(sqlitePath);
    try {
      const now = new Date().toISOString();
      db.prepare("UPDATE general_reminders SET status='acknowledged',acknowledged_at=?,updated_at=? WHERE id=? AND status IN ('active','failed','sending')")
        .run(now, now, reminderId);
    } finally { db.close(); }
    if (taskName && /^OpenClaw-General-/u.test(taskName)) await deleteTask(taskName);
  });

  undoManager.register("english-keyword", async ({ action, category, keyword }) => {
    await run({
      executable: process.env.MASHIROBOT_PYTHON || "python",
      args: [path.join(pluginRoot, "planner", "planner.py"), "manage-english-keywords", "--action", action, "--category", category, "--keyword", keyword],
      timeoutProfile: "python",
      operation: "manage-english-keyword",
      env: { ...process.env, PYTHONUTF8: "1", OPENCLAW_PLANNER_DB_PATH: sqlitePath },
    });
  });

  undoManager.register("plan-version", async ({ planDate, revisionNo }) => {
    const db = openControlDatabase(sqlitePath);
    let previous;
    let items;
    try {
      previous = db.prepare("SELECT id,raw_text FROM plan_revisions WHERE plan_date=? AND revision_no<? ORDER BY revision_no DESC LIMIT 1")
        .get(planDate, revisionNo);
      if (previous) {
        items = db.prepare("SELECT start_time startTime,end_time endTime,title FROM plan_items WHERE revision_id=? ORDER BY start_time")
          .all(previous.id);
      }
    } finally { db.close(); }
    if (!previous) throw new Error("没有可恢复的上一计划版本");
    const payload = Buffer.from(JSON.stringify({ date: planDate, rawText: previous.raw_text, items }), "utf8").toString("base64");
    await run({
      executable: process.env.MASHIROBOT_PWSH || "pwsh.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(pluginRoot, "windows", "manage-plan.ps1"), "-Action", "SavePlan", "-PayloadBase64", payload],
      timeoutMs: 45_000,
      operation: "restore-plan-version",
      env: { ...process.env, OPENCLAW_PLANNER_DB_PATH: sqlitePath },
      maxStdoutBytes: 4 * 1024 * 1024,
    });
  });

  lifecycleHooks.registerAcknowledgement("mashirobot-plugin-plan", "user", async (reminder) => {
    if (!reminder.sourceRef) return { cleanupPending: false };
    const db = openControlDatabase(sqlitePath);
    let taskName;
    try {
      taskName = db.prepare("SELECT windows_task_name FROM general_reminders WHERE id=?").get(reminder.sourceRef)?.windows_task_name ?? null;
      const now = new Date().toISOString();
      db.prepare("UPDATE general_reminders SET status='acknowledged',acknowledged_at=?,updated_at=? WHERE id=? AND status IN ('active','failed','sending')")
        .run(now, now, reminder.sourceRef);
    } finally { db.close(); }
    if (!taskName || !/^OpenClaw-General-/u.test(taskName)) return { cleanupPending: false };
    try { await deleteTask(taskName); return { cleanupPending: false }; }
    catch { return { cleanupPending: true }; }
  });

  lifecycleHooks.registerCurrentTasks("mashirobot-plugin-plan", () => {
    const db = openControlDatabase(sqlitePath);
    const date = clock.shanghaiDate();
    try {
      const plans = db.prepare("SELECT title,start_time,end_time,item_status FROM plan_items WHERE plan_date=? AND item_status='active' ORDER BY start_time").all(date);
      const state = db.prepare("SELECT value_json FROM plugin_runtime_state WHERE plugin_id='mashirobot-plugin-plan' AND state_key=?").all(`night:${date}`);
      let night = "提醒进行中";
      if (state.length) {
        try {
          const value = JSON.parse(state[0].value_json);
          night = value.slept ? "已睡觉，提醒已停止" : value.dismissed ? "今晚已停止提醒" : value.remindAfter ? `延迟至 ${String(value.remindAfter).slice(11, 16)}` : night;
        } catch { night = "状态无法解析"; }
      }
      return [
        { title: "今天计划", status: "ok", items: plans.map((item) => `${item.start_time ?? ""}-${item.end_time ?? ""} ${item.title} [${item.item_status}]`) },
        { title: "今晚睡觉提醒", status: "ok", items: state.length ? [night] : [] },
      ];
    } finally { db.close(); }
  });
}
