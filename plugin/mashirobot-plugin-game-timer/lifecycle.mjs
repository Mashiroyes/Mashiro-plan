import { openControlDatabase } from "../../core/control/database.mjs";

export function registerGameTimerLifecycle({ undoManager, lifecycleHooks, sqlitePath, runLocalProcess, logger, clock }) {
  undoManager.register("game-timer", async ({ id, reminderTaskName, forceTaskName }) => {
    const db = openControlDatabase(sqlitePath);
    try {
      db.prepare("UPDATE game_timer_tasks SET status='cancelled',version=version+1,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
    } finally { db.close(); }
    for (const taskName of [reminderTaskName, forceTaskName]) {
      if (!taskName || !/^MashiroBot/u.test(taskName)) continue;
      try {
        await runLocalProcess({
          executable: "schtasks.exe",
          args: ["/Delete", "/TN", taskName, "/F"],
          timeoutProfile: "schtasks",
          operation: "game-timer-delete-scheduled-task",
          pluginId: "mashirobot-plugin-game-timer",
          logger,
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024,
        });
      } catch (error) {
        const detail = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
        if (!/cannot find|not found|找不到指定的文件|系统找不到/iu.test(detail)) throw error;
      }
    }
  });

  lifecycleHooks.registerCurrentTasks("mashirobot-plugin-game-timer", () => {
    const db = openControlDatabase(sqlitePath);
    const now = clock.utcNow().toISOString();
    try {
      const timers = db.prepare("SELECT short_id,display_name,reminder_at,force_at FROM game_timer_tasks WHERE status IN ('pending','active','reminded','reminder_failed','path_mismatch') AND lock_until>? ORDER BY reminder_at").all(now);
      let releases = [];
      try { releases = db.prepare("SELECT display_name,expires_at FROM block_releases WHERE expires_at>? ORDER BY expires_at").all(now); } catch {}
      return [
        { title: "游戏计时", status: "ok", items: timers.map((item) => `${item.short_id} ${item.display_name}，提醒 ${item.reminder_at}，强退 ${item.force_at}`) },
        { title: "临时解除", status: "ok", items: releases.map((item) => `${item.display_name} 至 ${item.expires_at}`) },
      ];
    } finally { db.close(); }
  });
}
