import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const OPEN_STATES = "'pending','preparing','quarantined','restore_conflict'";

function openDatabase(sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS game_executable_vault (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL UNIQUE,
    game_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    original_path TEXT NOT NULL,
    vault_path TEXT,
    sha256 TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending','preparing','quarantined','restored','missing','invalid','restore_conflict','failed')),
    requested_at TEXT NOT NULL,
    protected_at TEXT,
    restore_due_at TEXT,
    restored_at TEXT,
    restore_task_name TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_game_vault_due ON game_executable_vault(state, restore_due_at);`);
  return db;
}

function map(row) {
  if (!row) return null;
  return { id: row.id, taskId: row.task_id, gameKey: row.game_key, displayName: row.display_name,
    originalPath: row.original_path, vaultPath: row.vault_path, sha256: row.sha256, state: row.state,
    requestedAt: row.requested_at, protectedAt: row.protected_at, restoreDueAt: row.restore_due_at,
    restoredAt: row.restored_at, restoreTaskName: row.restore_task_name, error: row.error, updatedAt: row.updated_at };
}

export function createGameVaultStore(sqlitePath) {
  const resolved = path.resolve(String(sqlitePath));
  const withDb = (callback) => { const db = openDatabase(resolved); try { return callback(db); } finally { db.close(); } };
  return Object.freeze({
    initialize() { return withDb(() => true); },
    queue(task, now = new Date()) {
      const at = new Date(now).toISOString();
      return withDb((db) => {
        db.prepare(`INSERT OR IGNORE INTO game_executable_vault
          (task_id,game_key,display_name,original_path,state,requested_at,updated_at)
          VALUES (?,?,?,?,'pending',?,?)`).run(task.id, task.gameKey, task.displayName, task.executablePath, at, at);
        return map(db.prepare("SELECT * FROM game_executable_vault WHERE task_id=?").get(task.id));
      });
    },
    get(id) { return withDb((db) => map(db.prepare("SELECT * FROM game_executable_vault WHERE id=?").get(id))); },
    getByTaskId(taskId) { return withDb((db) => map(db.prepare("SELECT * FROM game_executable_vault WHERE task_id=?").get(taskId))); },
    listOpen() { return withDb((db) => db.prepare(`SELECT * FROM game_executable_vault WHERE state IN (${OPEN_STATES}) ORDER BY requested_at`).all().map(map)); },
    listDue(now = new Date()) { return withDb((db) => db.prepare("SELECT * FROM game_executable_vault WHERE state IN ('quarantined','restore_conflict') AND restore_due_at<=? ORDER BY restore_due_at").all(new Date(now).toISOString()).map(map)); },
    hasProtectedGame(gameKey) { return withDb((db) => map(db.prepare(`SELECT * FROM game_executable_vault WHERE game_key=? AND state IN (${OPEN_STATES}) ORDER BY requested_at DESC LIMIT 1`).get(gameKey))); },
  });
}
