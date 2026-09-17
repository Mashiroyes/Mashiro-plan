import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ACTIVE_STATUSES = "'pending','active','reminded','reminder_failed','path_mismatch'";

function openDatabase(sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_timer_tasks (
      id TEXT PRIMARY KEY,
      game_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      process_name TEXT NOT NULL,
      executable_path TEXT NOT NULL,
      executable_key TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      force_after INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      reminder_at TEXT NOT NULL,
      force_at TEXT NOT NULL,
      lock_until TEXT NOT NULL,
      status TEXT NOT NULL,
      reminder_task_name TEXT,
      force_task_name TEXT,
      reminded_at TEXT,
      closed_pids_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_game_timer_active_lock
      ON game_timer_tasks(executable_key, lock_until, status);
  `);
  return db;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    gameKey: row.game_key,
    displayName: row.display_name,
    processName: row.process_name,
    executablePath: row.executable_path,
    executableKey: row.executable_key,
    minutes: row.minutes,
    forceAfter: row.force_after,
    startedAt: row.started_at,
    reminderAt: row.reminder_at,
    forceAt: row.force_at,
    lockUntil: row.lock_until,
    status: row.status,
    reminderTaskName: row.reminder_task_name,
    forceTaskName: row.force_task_name,
    remindedAt: row.reminded_at,
    closedPids: row.closed_pids_json ? JSON.parse(row.closed_pids_json) : [],
    error: row.error,
  };
}

export function createGameTimerStore(sqlitePath) {
  const resolved = path.resolve(String(sqlitePath));

  function withDb(callback) {
    const db = openDatabase(resolved);
    try { return callback(db); } finally { db.close(); }
  }

  function activeStatement(db) {
    return db.prepare(`
      SELECT * FROM game_timer_tasks
      WHERE executable_key = ? AND lock_until > ? AND status IN (${ACTIVE_STATUSES})
      ORDER BY started_at DESC LIMIT 1
    `);
  }

  return Object.freeze({
    sqlitePath: resolved,
    initialize() { return withDb(() => true); },
    createPending(task) {
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = activeStatement(db).get(task.executableKey, task.startedAt);
          if (existing) {
            db.exec("COMMIT");
            return { created: false, task: mapRow(existing) };
          }
          db.prepare(`
            INSERT INTO game_timer_tasks (
              id, game_key, display_name, process_name, executable_path, executable_key,
              minutes, force_after, started_at, reminder_at, force_at, lock_until,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(
            task.id, task.gameKey, task.displayName, task.processName,
            task.executablePath, task.executableKey, task.minutes, task.forceAfter,
            task.startedAt, task.reminderAt, task.forceAt, task.lockUntil,
            task.startedAt, task.startedAt,
          );
          db.exec("COMMIT");
          return { created: true, task: { ...task, status: "pending" } };
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    activate(id, { reminderTaskName, forceTaskName }, updatedAt = new Date().toISOString()) {
      return withDb((db) => db.prepare(`
        UPDATE game_timer_tasks SET status='active', reminder_task_name=?, force_task_name=?, updated_at=?
        WHERE id=?
      `).run(reminderTaskName, forceTaskName, updatedAt, id));
    },
    fail(id, error, updatedAt = new Date().toISOString()) {
      return withDb((db) => db.prepare(`
        UPDATE game_timer_tasks SET status='failed', error=?, updated_at=? WHERE id=?
      `).run(String(error), updatedAt, id));
    },
    getActiveByExecutable(executableKey, now = new Date()) {
      const iso = new Date(now).toISOString();
      return withDb((db) => mapRow(activeStatement(db).get(executableKey, iso)));
    },
    listActive(now = new Date()) {
      const iso = new Date(now).toISOString();
      return withDb((db) => db.prepare(`
        SELECT * FROM game_timer_tasks
        WHERE lock_until > ? AND status IN (${ACTIVE_STATUSES}) ORDER BY reminder_at
      `).all(iso).map(mapRow));
    },
    get(id) {
      return withDb((db) => mapRow(db.prepare("SELECT * FROM game_timer_tasks WHERE id=?").get(id)));
    },
  });
}
