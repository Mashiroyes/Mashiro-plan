import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { evaluateReleaseQuota } from "./release-quota.mjs";

function openDatabase(sqlitePath) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(path.resolve(String(sqlitePath)));
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS block_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('software','website')),
      target_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, target_key)
    );
    CREATE INDEX IF NOT EXISTS idx_block_rules_active_expiry ON block_rules(active, expires_at);
    CREATE TABLE IF NOT EXISTS block_releases (
      target_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_block_releases_expiry ON block_releases(expires_at);
    CREATE TABLE IF NOT EXISTS block_release_intervals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_block_release_intervals_target_time ON block_release_intervals(target_key,start_at,end_at);
    CREATE TABLE IF NOT EXISTS block_daily_release_defaults (
      local_date TEXT PRIMARY KEY,
      target_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const releaseColumns = db.prepare("PRAGMA table_info(block_releases)").all();
  if (!releaseColumns.some((column) => column.name === "interval_id")) {
    db.exec("ALTER TABLE block_releases ADD COLUMN interval_id INTEGER");
  }
  return db;
}

function mapRow(row) {
  if (!row) return null;
  return { id: row.id, kind: row.kind, targetKey: row.target_key, displayName: row.display_name, expiresAt: row.expires_at, active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at };
}

function isEffective(row, iso) { return row.active === 1 && (row.expires_at === null || row.expires_at > iso); }

function mapRelease(row) {
  if (!row) return null;
  return { targetKey: row.target_key, displayName: row.display_name, expiresAt: row.expires_at, intervalId: row.interval_id ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapInterval(row) { return { id: row.id, startAt: row.start_at, endAt: row.end_at }; }

function shanghaiDate(now) {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("now 必须是有效时间。");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function createBlockStore(sqlitePath) {
  const resolved = path.resolve(String(sqlitePath));
  function withDb(callback) { const db = openDatabase(resolved); try { return callback(db); } finally { db.close(); } }
  return Object.freeze({
    sqlitePath: resolved,
    initialize() { return withDb(() => true); },
    upsert({ kind, targetKey, displayName, expiresAt }, now = new Date()) {
      const updatedAt = new Date(now).toISOString();
      return withDb((db) => {
        db.prepare(`
          INSERT INTO block_rules(kind,target_key,display_name,expires_at,active,created_at,updated_at)
          VALUES(?,?,?,?,1,?,?)
          ON CONFLICT(kind,target_key) DO UPDATE SET
            display_name=excluded.display_name,
            expires_at=CASE WHEN block_rules.expires_at IS NULL OR excluded.expires_at IS NULL THEN NULL
                            WHEN excluded.expires_at > block_rules.expires_at THEN excluded.expires_at
                            ELSE block_rules.expires_at END,
            active=1, updated_at=excluded.updated_at
        `).run(kind, targetKey, displayName, expiresAt, updatedAt, updatedAt);
        return mapRow(db.prepare("SELECT * FROM block_rules WHERE kind=? AND target_key=?").get(kind, targetKey));
      });
    },
    listEffective(now = new Date()) {
      const iso = new Date(now).toISOString();
      return withDb((db) => db.prepare("SELECT * FROM block_rules WHERE active=1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY kind, display_name").all(iso).map(mapRow));
    },
    listEnforced(now = new Date()) {
      const iso = new Date(now).toISOString();
      return withDb((db) => db.prepare(`
        SELECT r.* FROM block_rules r
        LEFT JOIN block_releases x ON x.target_key=r.target_key AND x.expires_at>?
        WHERE r.active=1 AND (r.expires_at IS NULL OR r.expires_at>?) AND x.target_key IS NULL
        ORDER BY r.kind,r.display_name
      `).all(iso, iso).map(mapRow));
    },
    getEffectiveWebsite(targetKey, now = new Date()) {
      const iso = new Date(now).toISOString();
      return withDb((db) => mapRow(db.prepare("SELECT * FROM block_rules WHERE kind='website' AND target_key=? AND active=1 AND (expires_at IS NULL OR expires_at>?)").get(targetKey, iso)));
    },
    setDailyReleaseDefault(targetKey, displayName, now = new Date()) {
      const localDate = shanghaiDate(now);
      const updatedAt = new Date(now).toISOString();
      return withDb((db) => {
        db.prepare(`
          INSERT INTO block_daily_release_defaults(local_date,target_key,display_name,updated_at)
          VALUES(?,?,?,?)
          ON CONFLICT(local_date) DO UPDATE SET target_key=excluded.target_key,display_name=excluded.display_name,updated_at=excluded.updated_at
        `).run(localDate, targetKey, displayName, updatedAt);
        return { localDate, targetKey, displayName, updatedAt };
      });
    },
    getDailyReleaseDefault(now = new Date()) {
      const localDate = shanghaiDate(now);
      return withDb((db) => {
        const row = db.prepare("SELECT * FROM block_daily_release_defaults WHERE local_date=?").get(localDate);
        return row ? { localDate, targetKey: row.target_key, displayName: row.display_name, updatedAt: row.updated_at } : null;
      });
    },
    release({ targetKey, displayName, expiresAt }, now = new Date()) {
      const updatedAt = new Date(now).toISOString();
      return withDb((db) => {
        db.prepare(`
          INSERT INTO block_releases(target_key,display_name,expires_at,created_at,updated_at)
          VALUES(?,?,?,?,?)
          ON CONFLICT(target_key) DO UPDATE SET display_name=excluded.display_name,expires_at=excluded.expires_at,updated_at=excluded.updated_at
        `).run(targetKey, displayName, expiresAt, updatedAt, updatedAt);
        return mapRelease(db.prepare("SELECT * FROM block_releases WHERE target_key=?").get(targetKey));
      });
    },
    tryRelease({ targetKey, displayName, expiresAt }, now = new Date()) {
      const nowIso = new Date(now).toISOString();
      const expiresIso = new Date(expiresAt).toISOString();
      if (expiresIso <= nowIso) throw new RangeError("解除结束时间必须晚于开始时间。");
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db.prepare("SELECT * FROM block_releases WHERE target_key=?").get(targetKey);
          const rows = db.prepare("SELECT * FROM block_release_intervals WHERE target_key=? ORDER BY start_at,id").all(targetKey);
          const intervals = rows.map(mapInterval);
          if (current?.expires_at > nowIso) {
            if (current.interval_id) {
              const active = intervals.find((interval) => interval.id === current.interval_id);
              if (active && active.endAt > nowIso) active.endAt = nowIso;
            } else if (current.created_at < nowIso) {
              intervals.push({ id: null, startAt: current.created_at, endAt: nowIso });
            }
          }
          const quota = evaluateReleaseQuota({ intervals, proposedStart: nowIso, proposedEnd: expiresIso });
          if (!quota.allowed) {
            db.exec("ROLLBACK");
            return { allowed: false, release: current ? mapRelease(current) : null, quota };
          }
          if (current?.expires_at > nowIso) {
            if (current.interval_id) {
              db.prepare("UPDATE block_release_intervals SET end_at=?,updated_at=? WHERE id=? AND end_at>?").run(nowIso, nowIso, current.interval_id, nowIso);
            } else if (current.created_at < nowIso) {
              db.prepare("INSERT INTO block_release_intervals(target_key,display_name,start_at,end_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
                .run(targetKey, current.display_name, current.created_at, nowIso, current.created_at, nowIso);
            }
          }
          const inserted = db.prepare("INSERT INTO block_release_intervals(target_key,display_name,start_at,end_at,created_at,updated_at) VALUES(?,?,?,?,?,?)")
            .run(targetKey, displayName, nowIso, expiresIso, nowIso, nowIso);
          db.prepare(`
            INSERT INTO block_releases(target_key,display_name,expires_at,created_at,updated_at,interval_id)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(target_key) DO UPDATE SET display_name=excluded.display_name,expires_at=excluded.expires_at,updated_at=excluded.updated_at,interval_id=excluded.interval_id
          `).run(targetKey, displayName, expiresIso, nowIso, nowIso, Number(inserted.lastInsertRowid));
          const release = mapRelease(db.prepare("SELECT * FROM block_releases WHERE target_key=?").get(targetKey));
          db.exec("COMMIT");
          return { allowed: true, release, quota };
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { }
          throw error;
        }
      });
    },
    restoreRelease(targetKey, now = new Date()) {
      const nowIso = new Date(now).toISOString();
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db.prepare("SELECT * FROM block_releases WHERE target_key=?").get(targetKey);
          if (!current) { db.exec("COMMIT"); return false; }
          if (current.interval_id) db.prepare("UPDATE block_release_intervals SET end_at=?,updated_at=? WHERE id=? AND end_at>?").run(nowIso, nowIso, current.interval_id, nowIso);
          db.prepare("DELETE FROM block_releases WHERE target_key=?").run(targetKey);
          db.exec("COMMIT");
          return true;
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { }
          throw error;
        }
      });
    },
    deactivateMany(items, now = new Date()) {
      const updatedAt = new Date(now).toISOString();
      return withDb((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          let changes = 0;
          for (const item of items) {
            changes += db.prepare("UPDATE block_rules SET active=0,updated_at=? WHERE kind=? AND target_key=? AND active=1")
              .run(updatedAt, item.kind, item.targetKey).changes;
            db.prepare("DELETE FROM block_releases WHERE target_key=?").run(item.targetKey);
            db.prepare("DELETE FROM block_release_intervals WHERE target_key=?").run(item.targetKey);
            db.prepare("DELETE FROM block_daily_release_defaults WHERE target_key=?").run(item.targetKey);
          }
          db.exec("COMMIT");
          return { changes };
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    listReleases(now = new Date()) {
      const iso = new Date(now).toISOString();
      return withDb((db) => db.prepare("SELECT * FROM block_releases WHERE expires_at>? ORDER BY display_name").all(iso).map(mapRelease));
    },
    listAll() { return withDb((db) => db.prepare("SELECT * FROM block_rules ORDER BY kind, display_name").all().map(mapRow)); },
    expire(now = new Date()) {
      const iso = new Date(now).toISOString();
      const cutoff = shanghaiDate(new Date(new Date(now).getTime() - 8 * 86_400_000));
      return withDb((db) => {
        const expiredRules = db.prepare("UPDATE block_rules SET active=0, updated_at=? WHERE active=1 AND expires_at IS NOT NULL AND expires_at <= ?").run(iso, iso).changes;
        const expiredReleases = db.prepare("DELETE FROM block_releases WHERE expires_at<=?").run(iso).changes;
        const historyCutoff = new Date(new Date(now).getTime() - 9 * 86_400_000).toISOString();
        db.prepare("DELETE FROM block_release_intervals WHERE end_at<?").run(historyCutoff);
        db.prepare("DELETE FROM block_daily_release_defaults WHERE local_date<?").run(cutoff);
        return { expiredRules, expiredReleases };
      });
    },
  });
}
