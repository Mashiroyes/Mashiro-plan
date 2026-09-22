import { randomUUID } from "node:crypto";
import { applyControlMigrations, openControlDatabase } from "./database.mjs";

function shortError(error) { return String(error instanceof Error ? error.message : error).replace(/\s+/gu, " ").trim().slice(0, 240); }

export function createUndoManager({ sqlitePath, handlers = {}, now = () => new Date(), ttlMs = 30 * 60_000 } = {}) {
  const withDb = (fn) => { const db = openControlDatabase(sqlitePath); try { applyControlMigrations(db, { now: now() }); return fn(db); } finally { db.close(); } };
  return Object.freeze({
    record({ scope = "global", owner, actionKind, description, inversePayload = null, reversible = true, recoveryCommand = null, expiresAt = null }) {
      const created = now(); const id = randomUUID();
      withDb((db) => db.prepare("INSERT INTO undo_journal VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, scope, owner, actionKind, description, inversePayload == null ? null : JSON.stringify(inversePayload), reversible ? 1 : 0, recoveryCommand, "available", new Date(expiresAt ?? created.getTime() + ttlMs).toISOString(), null, created.toISOString(), created.toISOString()));
      return { undoId: id, reversible };
    },
    list(scope = "global") { return withDb((db) => db.prepare("SELECT * FROM undo_journal WHERE scope=? ORDER BY created_at DESC").all(scope)); },
    async undoLatest(scope = "global") {
      const current = now();
      const row = withDb((db) => { db.prepare("UPDATE undo_journal SET status='expired',updated_at=? WHERE scope=? AND status='available' AND expires_at<=?").run(current.toISOString(), scope, current.toISOString()); return db.prepare("SELECT * FROM undo_journal WHERE scope=? AND status='available' ORDER BY created_at DESC LIMIT 1").get(scope); });
      if (!row) return { status: "none" };
      if (!row.reversible) return { status: "recovery", description: row.description, recoveryCommand: row.recovery_command };
      const handler = handlers[row.action_kind];
      if (!handler) return { status: "unsupported", description: row.description };
      withDb((db) => db.prepare("UPDATE undo_journal SET status='applying',updated_at=? WHERE undo_id=? AND status='available'").run(current.toISOString(), row.undo_id));
      try { await handler(JSON.parse(row.inverse_payload_json ?? "null"), row); withDb((db) => db.prepare("UPDATE undo_journal SET status='undone',error=NULL,updated_at=? WHERE undo_id=?").run(now().toISOString(), row.undo_id)); return { status: "undone", description: row.description }; }
      catch (error) { withDb((db) => db.prepare("UPDATE undo_journal SET status='available',error=?,updated_at=? WHERE undo_id=?").run(shortError(error), now().toISOString(), row.undo_id)); return { status: "failed", description: row.description }; }
    },
  });
}
