import { randomUUID } from "node:crypto";
import { applyControlMigrations, openControlDatabase } from "./database.mjs";

export const REMINDER_PRIORITIES = Object.freeze({ statistics: 1, habit: 2, plan: 3, user: 4, disk: 5, wakeup: 6 });
const ACK = /^(?:收到|收到了|知道了|不用提醒了)(?:\s+(R\d{3}))?$/iu;

function shortIdFor(db) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = `R${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
    if (!db.prepare("SELECT 1 FROM managed_reminders WHERE short_id=? AND status IN ('pending','sending','sent')").get(id)) return id;
  }
  throw new Error("unable to allocate reminder short ID");
}

function map(row) {
  if (!row) return null;
  return { id: row.id, shortId: row.short_id, sourcePlugin: row.source_plugin, kind: row.kind, priority: row.priority, content: row.content, requiresAck: Boolean(row.requires_ack), dedupeKey: row.dedupe_key, sourceRef: row.source_ref, dueAt: row.due_at, expiresAt: row.expires_at, status: row.status, lastSentAt: row.last_sent_at, error: row.error };
}

export function createReminderManager({ sqlitePath, now = () => new Date() }) {
  const withDb = (callback) => { const db = openControlDatabase(sqlitePath); try { applyControlMigrations(db); return callback(db); } finally { db.close(); } };
  const currentIso = () => new Date(now()).toISOString();
  return Object.freeze({
    register(input) {
      return withDb((db) => {
        if (input.dedupeKey) {
          const existing = db.prepare("SELECT * FROM managed_reminders WHERE source_plugin=? AND dedupe_key=? AND status IN ('pending','sending','sent')").get(input.sourcePlugin, input.dedupeKey);
          if (existing) {
            if (input.repeat && existing.status === "sent") {
              const at = currentIso();
              db.prepare("UPDATE managed_reminders SET status='pending',due_at=?,content=?,updated_at=? WHERE id=?")
                .run(new Date(input.dueAt ?? at).toISOString(), String(input.content), at, existing.id);
              return { created: false, reminder: map(db.prepare("SELECT * FROM managed_reminders WHERE id=?").get(existing.id)) };
            }
            return { created: false, reminder: map(existing) };
          }
        }
        const at = currentIso();
        const reminder = { id: input.id ?? randomUUID(), shortId: input.shortId ?? shortIdFor(db), dueAt: new Date(input.dueAt ?? at).toISOString(), expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null };
        db.prepare(`INSERT INTO managed_reminders(id,short_id,source_plugin,kind,priority,content,requires_ack,dedupe_key,source_ref,due_at,expires_at,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(reminder.id, reminder.shortId, input.sourcePlugin, input.kind, Number(input.priority), String(input.content), input.requiresAck ? 1 : 0, input.dedupeKey ?? null, input.sourceRef ?? null, reminder.dueAt, reminder.expiresAt, at, at);
        return { created: true, reminder: map(db.prepare("SELECT * FROM managed_reminders WHERE id=?").get(reminder.id)) };
      });
    },
    listCurrent() { return withDb((db) => db.prepare("SELECT * FROM managed_reminders WHERE status IN ('pending','sending','sent') ORDER BY priority DESC,due_at").all().map(map)); },
    pause(minutes) {
      const value = Number(minutes);
      if (!Number.isInteger(value) || value < 1 || value > 1440) throw new Error("暂停时间必须为1至1440分钟");
      const updatedAt = currentIso();
      const pausedUntil = new Date(new Date(now()).getTime() + value * 60_000).toISOString();
      withDb((db) => db.prepare(`INSERT INTO reminder_control_state(scope,paused_until,silent_until,updated_at) VALUES('global',?,NULL,?) ON CONFLICT(scope) DO UPDATE SET paused_until=excluded.paused_until,updated_at=excluded.updated_at`).run(pausedUntil, updatedAt));
      return { pausedUntil };
    },
    silenceTonight() {
      const local = new Date(new Date(now()).toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
      local.setHours(29, 59, 59, 999);
      const offset = 8 * 60 * 60 * 1000;
      const silentUntil = new Date(local.getTime() - offset).toISOString();
      const updatedAt = currentIso();
      withDb((db) => db.prepare(`INSERT INTO reminder_control_state(scope,paused_until,silent_until,updated_at) VALUES('global',NULL,?,?) ON CONFLICT(scope) DO UPDATE SET silent_until=excluded.silent_until,updated_at=excluded.updated_at`).run(silentUntil, updatedAt));
      return { silentUntil };
    },
    resume() { const updatedAt = currentIso(); withDb((db) => db.prepare(`INSERT INTO reminder_control_state(scope,paused_until,silent_until,updated_at) VALUES('global',NULL,NULL,?) ON CONFLICT(scope) DO UPDATE SET paused_until=NULL,silent_until=NULL,updated_at=excluded.updated_at`).run(updatedAt)); return { ok: true }; },
    claimDue({ limit = 20 } = {}) {
      return withDb((db) => {
        const at = currentIso();
        const control = db.prepare("SELECT * FROM reminder_control_state WHERE scope='global'").get();
        const paused = control?.paused_until && control.paused_until > at;
        const silent = control?.silent_until && control.silent_until > at;
        const rows = db.prepare(`SELECT * FROM managed_reminders WHERE status='pending' AND due_at<=? AND (expires_at IS NULL OR expires_at>=?) ORDER BY priority DESC,due_at LIMIT ?`).all(at, at, limit);
        const eligible = rows.filter((row) => row.priority === REMINDER_PRIORITIES.wakeup || (!paused && !silent));
        const update = db.prepare("UPDATE managed_reminders SET status='sending',updated_at=? WHERE id=? AND status='pending'");
        return eligible.filter((row) => update.run(at, row.id).changes === 1).map(map);
      });
    },
    claimForDispatch(reminderId, { mergePriorityAtMost = REMINDER_PRIORITIES.plan, limit = 20 } = {}) {
      return withDb((db) => {
        const at = currentIso();
        const control = db.prepare("SELECT * FROM reminder_control_state WHERE scope='global'").get();
        const paused = control?.paused_until && control.paused_until > at;
        const silent = control?.silent_until && control.silent_until > at;
        const target = db.prepare("SELECT * FROM managed_reminders WHERE id=? AND status='pending' AND due_at<=? AND (expires_at IS NULL OR expires_at>=?)").get(reminderId, at, at);
        if (!target || (target.priority !== REMINDER_PRIORITIES.wakeup && (paused || silent))) return [];
        const rows = db.prepare(`SELECT * FROM managed_reminders
          WHERE status='pending' AND due_at<=? AND (expires_at IS NULL OR expires_at>=?)
            AND (id=? OR priority<=?) ORDER BY priority DESC,due_at LIMIT ?`)
          .all(at, at, reminderId, Number(mergePriorityAtMost), limit);
        const update = db.prepare("UPDATE managed_reminders SET status='sending',updated_at=? WHERE id=? AND status='pending'");
        return rows.filter((row) => update.run(at, row.id).changes === 1).map(map);
      });
    },
    finishDelivery(id, { ok, error = null } = {}) { const at = currentIso(); return withDb((db) => db.prepare("UPDATE managed_reminders SET status=CASE WHEN ? THEN CASE WHEN requires_ack=1 THEN 'sent' ELSE 'acknowledged' END ELSE 'failed' END,last_sent_at=CASE WHEN ? THEN ? ELSE last_sent_at END,error=?,updated_at=? WHERE id=?").run(ok ? 1 : 0, ok ? 1 : 0, at, ok ? null : String(error ?? "delivery failed").slice(0, 500), at, id)); },
    cancelBySource(sourcePlugin, sourceRef, kind = null) {
      return withDb((db) => {
        const at = currentIso();
        const sql = kind
          ? "UPDATE managed_reminders SET status='cancelled',updated_at=? WHERE source_plugin=? AND source_ref=? AND kind=? AND status IN ('pending','sending','sent')"
          : "UPDATE managed_reminders SET status='cancelled',updated_at=? WHERE source_plugin=? AND source_ref=? AND status IN ('pending','sending','sent')";
        const values = kind ? [at, sourcePlugin, sourceRef, kind] : [at, sourcePlugin, sourceRef];
        return db.prepare(sql).run(...values).changes;
      });
    },
    acknowledge(text) {
      const match = ACK.exec(String(text ?? "").trim());
      if (!match) return null;
      return withDb((db) => {
        const waiting = db.prepare("SELECT * FROM managed_reminders WHERE requires_ack=1 AND status='sent' ORDER BY last_sent_at DESC").all();
        if (!waiting.length) return { status: "none" };
        let target;
        if (match[1]) target = waiting.find((row) => row.short_id.toUpperCase() === match[1].toUpperCase());
        else if (waiting.length === 1) target = waiting[0];
        else return { status: "ambiguous", reminders: waiting.map(map) };
        if (!target) return { status: "not-found", reminders: waiting.map(map) };
        const at = currentIso();
        db.prepare("UPDATE managed_reminders SET status='acknowledged',updated_at=? WHERE id=?").run(at, target.id);
        return { status: "acknowledged", reminder: map(target) };
      });
    },
  });
}
