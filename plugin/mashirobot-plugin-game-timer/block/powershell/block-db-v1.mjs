import { DatabaseSync } from "node:sqlite";

const [mode, sqlitePath] = process.argv.slice(2);
if (!mode || !sqlitePath) process.exit(2);
const db = new DatabaseSync(sqlitePath);
db.exec("PRAGMA busy_timeout=5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS block_releases (
    target_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS block_daily_release_defaults (
    local_date TEXT PRIMARY KEY,
    target_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
try {
  const now = new Date().toISOString();
  if (mode === "active") {
    const rows = db.prepare(`
      SELECT r.kind,r.target_key,r.display_name,r.expires_at
      FROM block_rules r
      LEFT JOIN block_releases x ON x.target_key=r.target_key AND x.expires_at>?
      WHERE r.active=1 AND (r.expires_at IS NULL OR r.expires_at>?) AND x.target_key IS NULL
      ORDER BY r.kind,r.target_key
    `).all(now, now);
    process.stdout.write(JSON.stringify(rows));
  } else if (mode === "released") {
    const rows = db.prepare(`
      SELECT x.target_key,x.display_name,x.expires_at
      FROM block_releases x
      JOIN block_rules r ON r.kind='website' AND r.target_key=x.target_key
      WHERE x.expires_at>? AND r.active=1 AND (r.expires_at IS NULL OR r.expires_at>?)
      ORDER BY x.target_key
    `).all(now, now);
    process.stdout.write(JSON.stringify(rows));
  } else if (mode === "expire") {
    const rules = db.prepare("UPDATE block_rules SET active=0,updated_at=? WHERE active=1 AND expires_at IS NOT NULL AND expires_at<=?").run(now, now).changes;
    const releases = db.prepare("DELETE FROM block_releases WHERE expires_at<=?").run(now).changes;
    process.stdout.write(JSON.stringify({ ok: true, expiredRules: rules, expiredReleases: releases }));
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally { db.close(); }
