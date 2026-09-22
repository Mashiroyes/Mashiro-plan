import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlugins } from "./loader/plugin-loader.mjs";
import { appendMashiroLog } from "./logging/logger.mjs";
import { createPictureHelpService } from "./menu/help-service.mjs";
import { createMenuSessionStore } from "./menu/menu-session.mjs";
import { createPluginRouter } from "./router/plugin-router.mjs";
import { migrateControlDatabase } from "./control/database.mjs";
import { inspectDatabase } from "./control/database-health.mjs";
import { createReminderManager } from "./control/reminder-manager.mjs";
import { createCommandRouter } from "./control/command-router.mjs";
import { createRotatingBackup } from "./control/backup-manager.mjs";
import { spawn } from "node:child_process";
import { openControlDatabase } from "./control/database.mjs";
import { reconcileWindowsTasks } from "./control/windows-task-reconciler.mjs";
import { createUndoManager } from "./control/undo-manager.mjs";
import { collectCurrentTasks, formatCurrentTasks } from "./control/current-tasks.mjs";
import { runSystemDiagnostics, formatDiagnostics } from "./control/system-diagnostics.mjs";

const coreDirectory = path.dirname(fileURLToPath(import.meta.url));
const planRoot = path.resolve(coreDirectory, "..");
const sqlitePath = path.join(planRoot, "sqlite", "openclaw-planner.sqlite");
createRotatingBackup({ sqlitePath, backupRoot: path.join(planRoot, "sqlite", "backups", "control"), reason: "startup-before-migration" });
migrateControlDatabase(sqlitePath);
const reminderManager = createReminderManager({ sqlitePath });
function runProcess(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; }); child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `process exited ${code}`)));
  });
}
const undoManager = createUndoManager({ sqlitePath, handlers: {
  "general-reminder": async ({ reminderId, taskName }) => {
    const db = openControlDatabase(sqlitePath); try { db.prepare("UPDATE general_reminders SET status='acknowledged',acknowledged_at=?,updated_at=? WHERE id=? AND status IN ('active','failed','sending')").run(new Date().toISOString(), new Date().toISOString(), reminderId); } finally { db.close(); }
    if (taskName && /^OpenClaw-General-/u.test(taskName)) await runProcess("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]).catch(() => {});
  },
  "game-timer": async ({ id, reminderTaskName, forceTaskName }) => {
    const db = openControlDatabase(sqlitePath); try { db.prepare("UPDATE game_timer_tasks SET status='cancelled',version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(), id); } finally { db.close(); }
    for (const taskName of [reminderTaskName, forceTaskName]) if (taskName && /^MashiroBot/u.test(taskName)) await runProcess("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]).catch(() => {});
  },
  "english-keyword": async ({ action, category, keyword }) => runProcess("python", [path.join(planRoot, "plugin", "mashirobot-plugin-plan", "planner", "planner.py"), "manage-english-keywords", "--action", action, "--category", category, "--keyword", keyword]),
  "plan-version": async ({ planDate, revisionNo }) => {
    const db = openControlDatabase(sqlitePath); let previous;
    try { previous = db.prepare("SELECT id,raw_text FROM plan_revisions WHERE plan_date=? AND revision_no<? ORDER BY revision_no DESC LIMIT 1").get(planDate, revisionNo); } finally { db.close(); }
    if (!previous) throw new Error("没有可恢复的上一计划版本");
    const read = openControlDatabase(sqlitePath); let items;
    try { items = read.prepare("SELECT start_time startTime,end_time endTime,title FROM plan_items WHERE revision_id=? ORDER BY start_time").all(previous.id); } finally { read.close(); }
    const payload = Buffer.from(JSON.stringify({ date: planDate, rawText: previous.raw_text, items }), "utf8").toString("base64");
    await runProcess("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(planRoot, "plugin", "mashirobot-plugin-plan", "windows", "manage-plan.ps1"), "-Action", "SavePlan", "-PayloadBase64", payload]);
  },
} });
reconcileWindowsTasks({ sqlitePath }).then((summary) => appendMashiroLog({ level: summary.ok ? "info" : "error", pluginId: "mashirobot-core", event: "job_reconcile", message: JSON.stringify({ missing: summary.missing?.length ?? 0, orphaned: summary.orphaned?.length ?? 0, failed: summary.failed?.length ?? 0 }) })).catch((error) => appendMashiroLog({ level: "error", pluginId: "mashirobot-core", event: "job_reconcile_failed", message: String(error.message ?? error).slice(0, 300) }));
const systemRouter = createCommandRouter({
  reminderManager,
  inspectDatabase: () => inspectDatabase(sqlitePath, { backupRoot: path.join(planRoot, "sqlite", "backups", "control") }),
  undoManager,
  currentTasks: () => formatCurrentTasks(collectCurrentTasks({ sqlitePath, reminderManager })),
  diagnostics: async () => formatDiagnostics(runSystemDiagnostics({ sqlitePath, planRoot, jobInspection: await reconcileWindowsTasks({ sqlitePath, apply: false }) })),
  onAcknowledge: async (reminder) => {
    if (reminder.sourcePlugin !== "mashirobot-plugin-plan" || reminder.kind !== "user" || !reminder.sourceRef) return;
    const db = openControlDatabase(sqlitePath);
    let taskName = null;
    try {
      const row = db.prepare("SELECT windows_task_name FROM general_reminders WHERE id=?").get(reminder.sourceRef);
      taskName = row?.windows_task_name ?? null;
      db.prepare("UPDATE general_reminders SET status='acknowledged',acknowledged_at=?,updated_at=? WHERE id=? AND status IN ('active','failed','sending')")
        .run(new Date().toISOString(), new Date().toISOString(), reminder.sourceRef);
    } finally { db.close(); }
    if (taskName && /^OpenClaw-General-/u.test(taskName)) {
      await new Promise((resolve) => {
        const child = spawn("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], { windowsHide: true, stdio: "ignore" });
        child.once("exit", resolve); child.once("error", resolve);
      });
    }
  },
});
const registry = await loadPlugins({
  pluginRoot: path.join(planRoot, "plugin"),
  logger: appendMashiroLog,
});
const menuSessions = createMenuSessionStore();
const routeMessage = createPluginRouter({
  registry,
  menuSessions,
  helpService: createPictureHelpService(),
  planRoot,
  logger: appendMashiroLog,
  systemRouter,
});

/**
 * Asynchronous OpenClaw entry point. Plugin discovery ran once above.
 */
export async function handleMashiroBotMessage(rawText, context = {}) {
  return routeMessage(rawText, { ...context, reminderManager, undoManager, planRoot: context.planRoot ?? planRoot });
}

export { registry as pluginRegistry };
