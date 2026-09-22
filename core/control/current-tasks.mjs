import { openControlDatabase } from "./database.mjs";

function safe(db, sql, params = []) { try { return db.prepare(sql).all(...params); } catch { return null; } }
function shanghaiDate(now) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(now)); }
function describeNight(raw) { try { const value = JSON.parse(raw); if (value.slept) return "已睡觉，提醒已停止"; if (value.dismissed) return "今晚已停止提醒"; if (value.remindAfter) return `延迟至 ${String(value.remindAfter).slice(11, 16)}`; return "提醒进行中"; } catch { return "状态无法解析"; } }

export function collectCurrentTasks({ sqlitePath, reminderManager, now = new Date() }) {
  const db = openControlDatabase(sqlitePath); const date = shanghaiDate(now); const sections = [];
  try {
    const plans = safe(db, "SELECT title,start_time,end_time,item_status FROM plan_items WHERE plan_date=? AND item_status='active' ORDER BY start_time", [date]);
    sections.push({ title: "今天计划", status: plans === null ? "unknown" : "ok", items: plans?.map((x) => `${x.start_time ?? ""}-${x.end_time ?? ""} ${x.title} [${x.item_status}]`) ?? [] });
    const reminders = reminderManager?.listCurrent?.() ?? [];
    sections.push({ title: "活动提醒", status: "ok", items: reminders.map((x) => `${x.shortId} ${x.content}`) });
    const timers = safe(db, "SELECT short_id,display_name,reminder_at,force_at FROM game_timer_tasks WHERE status IN ('pending','active','reminded','reminder_failed','path_mismatch') AND lock_until>? ORDER BY reminder_at", [new Date(now).toISOString()]);
    sections.push({ title: "游戏计时", status: timers === null ? "unknown" : "ok", items: timers?.map((x) => `${x.short_id} ${x.display_name}，提醒 ${x.reminder_at}，强退 ${x.force_at}`) ?? [] });
    const releases = safe(db, "SELECT display_name,expires_at FROM block_releases WHERE expires_at>? ORDER BY expires_at", [new Date(now).toISOString()]);
    sections.push({ title: "临时解除", status: releases === null ? "unknown" : "ok", items: releases?.map((x) => `${x.display_name} 至 ${x.expires_at}`) ?? [] });
    const state = safe(db, "SELECT value_json FROM plugin_runtime_state WHERE plugin_id='mashirobot-plugin-plan' AND state_key=?", [`night:${date}`]);
    sections.push({ title: "今晚睡觉提醒", status: state === null ? "unknown" : "ok", items: state?.length ? [describeNight(state[0].value_json)] : [] });
    return sections;
  } finally { db.close(); }
}

export function formatCurrentTasks(sections) {
  return sections.map((section) => `${section.title}：${section.status === "unknown" ? "未核验" : section.items.length ? section.items.join("；") : "无"}`).join("\n");
}
