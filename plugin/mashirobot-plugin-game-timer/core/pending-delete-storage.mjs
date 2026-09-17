import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ACTION_KEY = "batch-delete";
const TTL_MS = 10 * 60_000;

function open(sqlitePath) {
  const resolved = path.resolve(String(sqlitePath));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS game_timer_pending_actions (
    action_key TEXT PRIMARY KEY,
    action_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  return db;
}

export function createPendingDeleteStore(sqlitePath) {
  return Object.freeze({
    save(actionKind, payload, now = new Date()) {
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(new Date(now).getTime() + TTL_MS).toISOString();
      const db = open(sqlitePath);
      try {
        db.prepare(`INSERT INTO game_timer_pending_actions(action_key,action_kind,payload_json,expires_at,created_at)
          VALUES(?,?,?,?,?) ON CONFLICT(action_key) DO UPDATE SET
          action_kind=excluded.action_kind,payload_json=excluded.payload_json,
          expires_at=excluded.expires_at,created_at=excluded.created_at`)
          .run(ACTION_KEY, actionKind, JSON.stringify(payload), expiresAt, createdAt);
        return { actionKind, payload, expiresAt, createdAt };
      } finally { db.close(); }
    },
    consume(now = new Date()) {
      const iso = new Date(now).toISOString();
      const db = open(sqlitePath);
      try {
        db.exec("BEGIN IMMEDIATE");
        const row = db.prepare("SELECT * FROM game_timer_pending_actions WHERE action_key=?").get(ACTION_KEY);
        db.prepare("DELETE FROM game_timer_pending_actions WHERE action_key=?").run(ACTION_KEY);
        db.exec("COMMIT");
        if (!row || row.expires_at <= iso) return null;
        return { actionKind: row.action_kind, payload: JSON.parse(row.payload_json), expiresAt: row.expires_at, createdAt: row.created_at };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally { db.close(); }
    },
  });
}
