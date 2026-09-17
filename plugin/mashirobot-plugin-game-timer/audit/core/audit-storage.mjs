import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SHANGHAI_OFFSET = "+08:00";
const DEFAULT_WORKER_ID = "interactive";
const HEARTBEAT_STALE_MS = 3 * 60_000;

function openDatabase(sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_usage_targets (
      target_key TEXT NOT NULL,
      executable_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      executable_path TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(target_key, executable_key)
    );
    CREATE TABLE IF NOT EXISTS app_usage_intervals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      executable_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds >= 0),
      local_date TEXT NOT NULL,
      close_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_app_usage_interval_identity
      ON app_usage_intervals(target_key, started_at, ended_at, executable_path);
    CREATE INDEX IF NOT EXISTS idx_app_usage_interval_date
      ON app_usage_intervals(local_date, target_key);
    CREATE TABLE IF NOT EXISTS app_usage_daily_totals (
      local_date TEXT NOT NULL,
      target_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(local_date, target_key)
    );
    CREATE TABLE IF NOT EXISTS app_usage_worker_state (
      worker_id TEXT PRIMARY KEY,
      heartbeat_at INTEGER NOT NULL,
      current_target_key TEXT,
      current_executable_path TEXT,
      current_interval_started_at INTEGER,
      last_observed_at INTEGER NOT NULL,
      worker_version TEXT
    );
  `);
  return db;
}

function epoch(value, label) {
  const result = new Date(value).getTime();
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be a valid date`);
  return result;
}

function executableKey(value) {
  return path.win32.normalize(String(value)).toLocaleLowerCase("en-US");
}

function localDate(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

function nextShanghaiMidnight(ms) {
  return Date.parse(`${localDate(ms)}T16:00:00.000Z`);
}

function dateRange(from, to) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  if (dateOnly.test(String(from)) && dateOnly.test(String(to))) {
    return { fromDate: String(from), toDate: String(to) };
  }
  return { fromMs: epoch(from, "from"), toMs: epoch(to, "to") };
}

function splitInterval(event) {
  let start = epoch(event.startedAt, "startedAt");
  const end = epoch(event.endedAt, "endedAt");
  if (end <= start) return [];
  const result = [];
  while (start < end) {
    const boundary = nextShanghaiMidnight(start);
    const segmentEnd = Math.min(end, boundary);
    result.push({
      targetKey: String(event.targetKey),
      displayName: String(event.displayName ?? event.targetKey),
      executablePath: path.win32.normalize(String(event.executablePath)),
      startedAt: start,
      endedAt: segmentEnd,
      durationSeconds: Math.max(0, Math.round((segmentEnd - start) / 1000)),
      localDate: localDate(start),
      closeReason: String(event.closeReason ?? "unknown"),
    });
    start = segmentEnd;
  }
  return result;
}

function appendBatchToDb(db, events) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO app_usage_intervals
      (target_key, display_name, executable_path, started_at, ended_at,
       duration_seconds, local_date, close_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const event of events ?? []) {
      for (const segment of splitInterval(event)) {
        const result = insert.run(
          segment.targetKey, segment.displayName, segment.executablePath,
          segment.startedAt, segment.endedAt, segment.durationSeconds,
          segment.localDate, segment.closeReason, Date.now(),
        );
        inserted += Number(result.changes);
      }
    }
    db.exec("COMMIT");
    return { inserted };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createAuditStore(sqlitePath) {
  if (!sqlitePath) throw new TypeError("sqlitePath is required");
  const resolved = path.resolve(String(sqlitePath));
  function withDb(callback) {
    const db = openDatabase(resolved);
    try { return callback(db); } finally { db.close(); }
  }

  return Object.freeze({
    sqlitePath: resolved,
    initialize() { return withDb(() => true); },
    replaceTargets(targets, updatedAt = new Date()) {
      return withDb((db) => {
        const timestamp = epoch(updatedAt, "updatedAt");
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec("UPDATE app_usage_targets SET enabled=0");
          const upsert = db.prepare(`
            INSERT INTO app_usage_targets
              (target_key, executable_key, display_name, kind, executable_path, enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(target_key, executable_key) DO UPDATE SET
              display_name=excluded.display_name, kind=excluded.kind,
              executable_path=excluded.executable_path, enabled=1, updated_at=excluded.updated_at
          `);
          for (const target of targets ?? []) {
            upsert.run(
              String(target.key), executableKey(target.executablePath),
              String(target.displayName ?? target.key), String(target.kind ?? "game"),
              path.win32.normalize(String(target.executablePath)), timestamp,
            );
          }
          db.exec("COMMIT");
          return { count: (targets ?? []).length };
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    listTargets() {
      return withDb((db) => db.prepare(`
        SELECT target_key AS key, display_name AS displayName, kind,
          executable_path AS executablePath
        FROM app_usage_targets WHERE enabled=1 ORDER BY target_key, executable_key
      `).all());
    },
    appendBatch(events) {
      return withDb((db) => appendBatchToDb(db, events));
    },
    heartbeat(state) {
      return withDb((db) => {
        const observedAt = epoch(state.observedAt ?? new Date(), "observedAt");
        const startedAt = state.currentIntervalStartedAt
          ? epoch(state.currentIntervalStartedAt, "currentIntervalStartedAt")
          : null;
        db.prepare(`
          INSERT INTO app_usage_worker_state
            (worker_id, heartbeat_at, current_target_key, current_executable_path,
             current_interval_started_at, last_observed_at, worker_version)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(worker_id) DO UPDATE SET
            heartbeat_at=excluded.heartbeat_at,
            current_target_key=excluded.current_target_key,
            current_executable_path=excluded.current_executable_path,
            current_interval_started_at=excluded.current_interval_started_at,
            last_observed_at=excluded.last_observed_at,
            worker_version=excluded.worker_version
        `).run(
          String(state.workerId ?? DEFAULT_WORKER_ID), observedAt,
          state.currentTargetKey ?? null, state.currentExecutablePath ?? null,
          startedAt, observedAt, state.workerVersion ?? null,
        );
        return { ok: true };
      });
    },
    closeStaleInterval(workerId = DEFAULT_WORKER_ID) {
      return withDb((db) => {
        const row = db.prepare("SELECT * FROM app_usage_worker_state WHERE worker_id=?").get(workerId);
        if (!row?.current_target_key || !row.current_interval_started_at || row.last_observed_at <= row.current_interval_started_at) {
          return { inserted: 0 };
        }
        const target = db.prepare(`
          SELECT display_name FROM app_usage_targets
          WHERE target_key=? AND executable_key=? LIMIT 1
        `).get(row.current_target_key, executableKey(row.current_executable_path));
        const result = appendBatchToDb(db, [{
          targetKey: row.current_target_key,
          displayName: target?.display_name ?? row.current_target_key,
          executablePath: row.current_executable_path,
          startedAt: new Date(row.current_interval_started_at).toISOString(),
          endedAt: new Date(row.last_observed_at).toISOString(),
          closeReason: "worker-stale",
        }]);
        db.prepare(`
          UPDATE app_usage_worker_state SET current_target_key=NULL,
            current_executable_path=NULL, current_interval_started_at=NULL
          WHERE worker_id=?
        `).run(workerId);
        return result;
      });
    },
    workerHealth(now = new Date(), workerId = DEFAULT_WORKER_ID) {
      const current = epoch(now, "now");
      return withDb((db) => {
        const row = db.prepare("SELECT * FROM app_usage_worker_state WHERE worker_id=?").get(workerId);
        if (!row) return { fresh: false, heartbeatAt: null, ageSeconds: null };
        const ageMs = Math.max(0, current - row.heartbeat_at);
        return {
          fresh: ageMs <= HEARTBEAT_STALE_MS,
          heartbeatAt: new Date(row.heartbeat_at).toISOString(),
          ageSeconds: Math.floor(ageMs / 1000),
        };
      });
    },
    summary({ from, to, targetKey = null }) {
      const range = dateRange(from, to);
      return withDb((db) => {
        const totals = {};
        for (const row of db.prepare("SELECT DISTINCT target_key FROM app_usage_targets WHERE enabled=1").all()) {
          totals[row.target_key] = 0;
        }
        let rows;
        let archived;
        if (range.fromDate) {
          const params = targetKey
            ? [range.fromDate, range.toDate, targetKey]
            : [range.fromDate, range.toDate];
          const filter = targetKey ? " AND target_key=?" : "";
          rows = db.prepare(`
            SELECT target_key, SUM(duration_seconds) AS seconds
            FROM app_usage_intervals WHERE local_date BETWEEN ? AND ?${filter}
            GROUP BY target_key
          `).all(...params);
          archived = db.prepare(`
            SELECT target_key, SUM(duration_seconds) AS seconds
            FROM app_usage_daily_totals WHERE local_date BETWEEN ? AND ?${filter}
            GROUP BY target_key
          `).all(...params);
        } else {
          const filter = targetKey ? " AND target_key=?" : "";
          const params = targetKey
            ? [range.fromMs, range.toMs, targetKey]
            : [range.fromMs, range.toMs];
          rows = db.prepare(`
            SELECT target_key, SUM(duration_seconds) AS seconds
            FROM app_usage_intervals WHERE started_at >= ? AND ended_at <= ?${filter}
            GROUP BY target_key
          `).all(...params);
          archived = [];
        }
        for (const row of [...rows, ...archived]) {
          totals[row.target_key] = (totals[row.target_key] ?? 0) + Number(row.seconds ?? 0);
        }
        return { totals, health: this.workerHealth(new Date()) };
      });
    },
    aggregateBefore(cutoff) {
      const cutoffMs = epoch(cutoff, "cutoff");
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const rows = db.prepare(`
            SELECT local_date, target_key, MAX(display_name) AS display_name,
              SUM(duration_seconds) AS duration_seconds
            FROM app_usage_intervals WHERE ended_at < ?
            GROUP BY local_date, target_key
          `).all(cutoffMs);
          const upsert = db.prepare(`
            INSERT INTO app_usage_daily_totals
              (local_date, target_key, display_name, duration_seconds, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(local_date, target_key) DO UPDATE SET
              display_name=excluded.display_name,
              duration_seconds=app_usage_daily_totals.duration_seconds + excluded.duration_seconds,
              updated_at=excluded.updated_at
          `);
          for (const row of rows) {
            upsert.run(row.local_date, row.target_key, row.display_name, row.duration_seconds, Date.now());
          }
          const deleted = Number(db.prepare("DELETE FROM app_usage_intervals WHERE ended_at < ?").run(cutoffMs).changes);
          db.exec("COMMIT");
          return { aggregated: rows.length, deleted };
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
  });
}
