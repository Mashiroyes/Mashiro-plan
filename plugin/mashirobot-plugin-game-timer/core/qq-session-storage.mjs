import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { QQ_SPECIAL_COOLDOWN_MINUTES, cooldownMinutesForDailySession } from "./qq-session-model.mjs";

const BLOCKING_PHASES = "'preparing','playing','cooldown','uninstall_failed'";
const TRANSITIONS = new Map([
  ["preparing", new Set(["playing", "failed"])],
  ["playing", new Set(["cooldown", "uninstall_failed", "failed"])],
  ["cooldown", new Set(["ready", "uninstall_failed", "failed"])],
  ["uninstall_failed", new Set(["cooldown", "ready"])],
  ["ready", new Set()],
  ["failed", new Set()],
]);

function createSessionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_timed_sessions (
      id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL,
      play_minutes INTEGER NOT NULL,
      window_policy TEXT NOT NULL DEFAULT 'daily' CHECK(window_policy IN ('daily','sunday-4h')),
      special_local_date TEXT,
      special_consumed_at TEXT,
      confirmed_at TEXT,
      play_ends_at TEXT,
      cooldown_ends_at TEXT,
      phase TEXT NOT NULL CHECK(phase IN ('preparing','playing','cooldown','ready','failed','uninstall_failed')),
      transition_task_name TEXT,
      reconcile_task_name TEXT,
      uninstall_result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (window_policy='daily' AND play_minutes BETWEEN 1 AND 60 AND special_local_date IS NULL)
        OR
        (window_policy='sunday-4h' AND play_minutes BETWEEN 1 AND 240 AND special_local_date IS NOT NULL)
      )
    );
  `);
}

function migrateLegacySessionTable(db) {
  const columns = db.prepare("PRAGMA table_info(qq_timed_sessions)").all();
  if (!columns.length || columns.some((column) => column.name === "requested_at")) return;
  db.exec("ALTER TABLE qq_timed_sessions RENAME TO qq_timed_sessions_legacy");
  createSessionTable(db);
  db.exec(`
    INSERT INTO qq_timed_sessions
      (id, requested_at, play_minutes, confirmed_at, play_ends_at, cooldown_ends_at, phase,
       transition_task_name, reconcile_task_name, uninstall_result, error, created_at, updated_at)
    SELECT id, confirmed_at, 10, confirmed_at, play_ends_at, cooldown_ends_at,
      CASE phase WHEN 'pending' THEN 'preparing' ELSE phase END,
      transition_task_name, reconcile_task_name, uninstall_result, error, created_at, updated_at
    FROM qq_timed_sessions_legacy;
    DROP TABLE qq_timed_sessions_legacy;
  `);
}

function ensurePlayMinutesColumn(db) {
  const columns = db.prepare("PRAGMA table_info(qq_timed_sessions)").all();
  if (!columns.some((column) => column.name === "play_minutes")) {
    db.exec("ALTER TABLE qq_timed_sessions ADD COLUMN play_minutes INTEGER NOT NULL DEFAULT 10 CHECK(play_minutes BETWEEN 1 AND 60)");
  }
}

function ensureSessionPolicyColumns(db) {
  const columns = db.prepare("PRAGMA table_info(qq_timed_sessions)").all();
  if (columns.some((column) => column.name === "window_policy")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE qq_timed_sessions RENAME TO qq_timed_sessions_before_window_policy");
    createSessionTable(db);
    db.exec(`
      INSERT INTO qq_timed_sessions
        (id,requested_at,play_minutes,window_policy,special_local_date,special_consumed_at,
         confirmed_at,play_ends_at,cooldown_ends_at,phase,transition_task_name,reconcile_task_name,
         uninstall_result,error,created_at,updated_at)
      SELECT id,requested_at,play_minutes,'daily',NULL,NULL,
         confirmed_at,play_ends_at,cooldown_ends_at,phase,transition_task_name,reconcile_task_name,
         uninstall_result,error,created_at,updated_at
      FROM qq_timed_sessions_before_window_policy;
      DROP TABLE qq_timed_sessions_before_window_policy;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureSundayDurationConstraint(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='qq_timed_sessions'").get();
  if (!table?.sql || !/window_policy='sunday-4h'\s+AND\s+play_minutes=240/i.test(table.sql)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE qq_timed_sessions RENAME TO qq_timed_sessions_before_sunday_truncation");
    createSessionTable(db);
    db.exec(`
      INSERT INTO qq_timed_sessions
        (id,requested_at,play_minutes,window_policy,special_local_date,special_consumed_at,
         confirmed_at,play_ends_at,cooldown_ends_at,phase,transition_task_name,reconcile_task_name,
         uninstall_result,error,created_at,updated_at)
      SELECT id,requested_at,play_minutes,window_policy,special_local_date,special_consumed_at,
         confirmed_at,play_ends_at,cooldown_ends_at,phase,transition_task_name,reconcile_task_name,
         uninstall_result,error,created_at,updated_at
      FROM qq_timed_sessions_before_sunday_truncation;
      DROP TABLE qq_timed_sessions_before_sunday_truncation;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function openDatabase(sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  createSessionTable(db);
  migrateLegacySessionTable(db);
  ensurePlayMinutesColumn(db);
  ensureSessionPolicyColumns(db);
  ensureSundayDurationConstraint(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_qq_timed_sessions_blocking ON qq_timed_sessions(phase, cooldown_ends_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_qq_sunday_consumed_date
      ON qq_timed_sessions(special_local_date)
      WHERE window_policy='sunday-4h' AND special_consumed_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS qq_installer_vault (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      vault_path TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      signer TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','superseded','missing','invalid')),
      captured_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS qq_installed_executable_vault (
      id INTEGER PRIMARY KEY CHECK(id=1),
      original_path TEXT NOT NULL,
      vault_path TEXT,
      format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version IN (1,2)),
      sha256 TEXT,
      signer TEXT,
      state TEXT NOT NULL CHECK(state IN ('available','protecting','protected','restoring','conflict','invalid','missing')),
      protected_at TEXT,
      restored_at TEXT,
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS enforcement_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      target TEXT NOT NULL,
      session_id TEXT,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      detail_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_enforcement_audit_session ON enforcement_audit_events(session_id, occurred_at DESC);
  `);
  const vaultColumns = db.prepare("PRAGMA table_info(qq_installed_executable_vault)").all();
  if (!vaultColumns.some((column) => column.name === "format_version")) {
    db.exec("ALTER TABLE qq_installed_executable_vault ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version IN (1,2))");
  }
  return db;
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id, requestedAt: row.requested_at, playMinutes: row.play_minutes,
    windowPolicy: row.window_policy ?? "daily", specialLocalDate: row.special_local_date ?? null,
    specialConsumedAt: row.special_consumed_at ?? null, confirmedAt: row.confirmed_at,
    playEndsAt: row.play_ends_at, cooldownEndsAt: row.cooldown_ends_at,
    phase: row.phase, transitionTaskName: row.transition_task_name,
    reconcileTaskName: row.reconcile_task_name, uninstallResult: row.uninstall_result,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapEvent(row) {
  return {
    id: row.id, occurredAt: row.occurred_at, target: row.target, sessionId: row.session_id,
    action: row.action, result: row.result,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null, error: row.error,
  };
}

function mapInstalledExecutableVault(row) {
  if (!row) return null;
  return {
    originalPath: row.original_path, vaultPath: row.vault_path, formatVersion: Number(row.format_version ?? 1),
    sha256: row.sha256, signer: row.signer, state: row.state,
    protectedAt: row.protected_at, restoredAt: row.restored_at,
    error: row.error, updatedAt: row.updated_at,
  };
}

function shanghaiDateBounds(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new TypeError("confirmedAt must be valid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const startUtc = Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day), -8);
  return { start: new Date(startUtc).toISOString(), end: new Date(startUtc + 24 * 60 * 60_000).toISOString() };
}

export function createQqSessionStore(sqlitePath) {
  if (!sqlitePath) throw new TypeError("sqlitePath is required");
  const resolved = path.resolve(String(sqlitePath));
  const withDb = (callback) => { const db = openDatabase(resolved); try { return callback(db); } finally { db.close(); } };

  function appendEvent(db, sessionId, event, occurredAt) {
    if (!event?.action) return;
    db.prepare(`INSERT INTO enforcement_audit_events
      (occurred_at,target,session_id,action,result,detail_json,error) VALUES (?,'qq',?,?,?,?,?)`).run(
      occurredAt, sessionId ?? null, String(event.action), String(event.result ?? "ok"),
      event.detail === undefined ? null : JSON.stringify(event.detail),
      event.error === undefined ? null : String(event.error));
  }

  function blockingRow(db, nowIso) {
    return db.prepare(`SELECT * FROM qq_timed_sessions WHERE phase='preparing' OR
      (phase IN ('playing','cooldown','uninstall_failed') AND cooldown_ends_at > ?)
      ORDER BY requested_at DESC LIMIT 1`).get(nowIso);
  }

  return Object.freeze({
    sqlitePath: resolved,
    initialize() { return withDb(() => true); },
    createPreparing(request) {
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = blockingRow(db, request.requestedAt);
          if (existing) { db.exec("COMMIT"); return { created: false, session: mapSession(existing) }; }
          if (request.windowPolicy === "sunday-4h") {
            const consumed = db.prepare(`SELECT * FROM qq_timed_sessions
              WHERE window_policy='sunday-4h' AND special_local_date=? AND special_consumed_at IS NOT NULL
              ORDER BY special_consumed_at DESC LIMIT 1`).get(request.specialLocalDate);
            if (consumed) { db.exec("COMMIT"); return { created: false, reason: "sunday-limit", session: mapSession(consumed) }; }
          }
          db.prepare(`INSERT INTO qq_timed_sessions
            (id,requested_at,play_minutes,window_policy,special_local_date,special_consumed_at,phase,created_at,updated_at)
            VALUES (?,?,?,?,?,NULL,'preparing',?,?)`).run(
            request.id, request.requestedAt, request.playMinutes, request.windowPolicy ?? "daily",
            request.specialLocalDate ?? null, request.requestedAt, request.requestedAt);
          db.exec("COMMIT");
          return { created: true, session: this.get(request.id) };
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
    },
    activateAfterInstall(id, confirmedAt = new Date(), tasks = {}) {
      const confirmed = new Date(confirmedAt);
      if (Number.isNaN(confirmed.getTime())) throw new TypeError("confirmedAt must be valid");
      return withDb((db) => {
        const row = db.prepare("SELECT play_minutes,window_policy,special_local_date FROM qq_timed_sessions WHERE id=? AND phase='preparing'").get(id);
        if (!row) throw new Error(`QQ request cannot activate: ${id}`);
        const confirmedIso = confirmed.toISOString();
        const requestedPlayEnd = new Date(confirmed.getTime() + Number(row.play_minutes) * 60_000);
        const sundayMidnight = row.window_policy === "sunday-4h"
          ? new Date(`${row.special_local_date}T16:00:00.000Z`)
          : null;
        const playEndDate = sundayMidnight && sundayMidnight < requestedPlayEnd ? sundayMidnight : requestedPlayEnd;
        if (playEndDate <= confirmed) throw new Error(`Sunday QQ request cannot start after local midnight: ${id}`);
        const actualPlayMinutes = row.window_policy === "sunday-4h"
          ? Math.max(1, Math.ceil((playEndDate.getTime() - confirmed.getTime()) / 60_000))
          : Number(row.play_minutes);
        const playEndsAt = playEndDate.toISOString();
        let cooldownMinutes = QQ_SPECIAL_COOLDOWN_MINUTES;
        if (row.window_policy === "daily") {
          const day = shanghaiDateBounds(confirmed);
          const priorCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM qq_timed_sessions
            WHERE window_policy='daily' AND confirmed_at IS NOT NULL AND phase <> 'failed'
              AND confirmed_at >= ? AND confirmed_at < ?`).get(day.start, day.end).count);
          cooldownMinutes = cooldownMinutesForDailySession(priorCount + 1);
        }
        const cooldownEndsAt = new Date(new Date(playEndsAt).getTime() + cooldownMinutes * 60_000).toISOString();
        const result = db.prepare(`UPDATE qq_timed_sessions SET phase='playing', play_minutes=?, confirmed_at=?,
          play_ends_at=?, cooldown_ends_at=?, transition_task_name=?, reconcile_task_name=?, updated_at=?
          WHERE id=? AND phase='preparing'`).run(
          actualPlayMinutes, confirmedIso, playEndsAt, cooldownEndsAt, tasks.transitionTaskName ?? null,
          tasks.reconcileTaskName ?? null, confirmedIso, id);
        if (Number(result.changes) !== 1) throw new Error(`QQ request cannot activate: ${id}`);
        return mapSession(db.prepare("SELECT * FROM qq_timed_sessions WHERE id=?").get(id));
      });
    },
    consumeSundayAllowance(id, consumedAt = new Date()) {
      const consumed = new Date(consumedAt);
      if (Number.isNaN(consumed.getTime())) throw new TypeError("consumedAt must be valid");
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db.prepare("SELECT * FROM qq_timed_sessions WHERE id=?").get(id);
          if (!current || current.phase !== "playing" || current.window_policy !== "sunday-4h") {
            throw new Error(`Sunday QQ allowance cannot be consumed: ${id}`);
          }
          if (current.special_consumed_at) { db.exec("COMMIT"); return mapSession(current); }
          const consumedIso = consumed.toISOString();
          const result = db.prepare(`UPDATE qq_timed_sessions SET special_consumed_at=?,updated_at=?
            WHERE id=? AND phase='playing' AND window_policy='sunday-4h' AND special_consumed_at IS NULL`).run(
            consumedIso, consumedIso, id);
          if (Number(result.changes) !== 1) throw new Error(`Sunday QQ allowance cannot be consumed: ${id}`);
          const updated = db.prepare("SELECT * FROM qq_timed_sessions WHERE id=?").get(id);
          db.exec("COMMIT");
          return mapSession(updated);
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
    },
    fail(id, error, updatedAt = new Date().toISOString()) {
      return withDb((db) => db.prepare(`UPDATE qq_timed_sessions SET phase='failed',error=?,updated_at=?
        WHERE id=? AND phase='preparing'`).run(String(error), updatedAt, id));
    },
    setPhase(id, phase, event = null, updatedAt = new Date().toISOString()) {
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = mapSession(db.prepare("SELECT * FROM qq_timed_sessions WHERE id=?").get(id));
          if (!current) throw new Error(`QQ session not found: ${id}`);
          if (current.phase !== phase && !TRANSITIONS.get(current.phase)?.has(phase)) throw new Error(`Invalid QQ session transition: ${current.phase} -> ${phase}`);
          db.prepare(`UPDATE qq_timed_sessions SET phase=?,uninstall_result=COALESCE(?,uninstall_result),
            error=COALESCE(?,error),updated_at=? WHERE id=?`).run(
            phase, event?.uninstallResult ?? null, event?.error ?? null, updatedAt, id);
          appendEvent(db, id, event, updatedAt);
          db.exec("COMMIT");
          return mapSession(db.prepare("SELECT * FROM qq_timed_sessions WHERE id=?").get(id));
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      });
    },
    appendEvent(sessionId, event, occurredAt = new Date().toISOString()) { return withDb((db) => appendEvent(db, sessionId, event, occurredAt)); },
    getBlockingSession(now = new Date()) { return withDb((db) => mapSession(blockingRow(db, new Date(now).toISOString()))); },
    getActive(now = new Date()) { return this.getBlockingSession(now); },
    get(id) { return withDb((db) => mapSession(db.prepare("SELECT * FROM qq_timed_sessions WHERE id=?").get(id))); },
    getInstalledExecutableVault() {
      return withDb((db) => mapInstalledExecutableVault(db.prepare("SELECT * FROM qq_installed_executable_vault WHERE id=1").get()));
    },
    setInstalledExecutableVault(record) {
      if (!record?.originalPath || !record?.state) throw new TypeError("installed executable vault requires originalPath and state");
      return withDb((db) => {
        const now = record.updatedAt ?? new Date().toISOString();
        db.prepare(`INSERT INTO qq_installed_executable_vault
          (id,original_path,vault_path,format_version,sha256,signer,state,protected_at,restored_at,error,updated_at)
          VALUES (1,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET original_path=excluded.original_path,vault_path=excluded.vault_path,
          format_version=excluded.format_version,sha256=excluded.sha256,signer=excluded.signer,state=excluded.state,protected_at=excluded.protected_at,
          restored_at=excluded.restored_at,error=excluded.error,updated_at=excluded.updated_at`).run(
          record.originalPath, record.vaultPath ?? null, record.formatVersion ?? 1, record.sha256 ?? null, record.signer ?? null,
          record.state, record.protectedAt ?? null, record.restoredAt ?? null, record.error ?? null, now);
        return mapInstalledExecutableVault(db.prepare("SELECT * FROM qq_installed_executable_vault WHERE id=1").get());
      });
    },
    listRecentEvents(sessionId, limit = 20) {
      const safe = Math.max(1, Math.min(200, Number(limit) || 20));
      return withDb((db) => db.prepare(`SELECT * FROM enforcement_audit_events WHERE session_id=?
        ORDER BY occurred_at DESC,id DESC LIMIT ?`).all(sessionId, safe).map(mapEvent));
    },
  });
}
