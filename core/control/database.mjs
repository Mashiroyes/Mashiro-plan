import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTROL_MIGRATIONS, migrationChecksum } from "./migrations.mjs";

export function openControlDatabase(sqlitePath) {
  const resolved = path.resolve(String(sqlitePath));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  return db;
}

export function ensureMigrationTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

export function applyControlMigrations(db, { now = new Date() } = {}) {
  ensureMigrationTable(db);
  const applied = db.prepare("SELECT migration_id,checksum FROM schema_migrations").all();
  const existing = new Map(applied.map((row) => [row.migration_id, row.checksum]));
  const completed = [];
  for (const migration of CONTROL_MIGRATIONS) {
    const checksum = migrationChecksum(migration);
    if (existing.has(migration.id)) {
      if (existing.get(migration.id) !== checksum) throw new Error(`migration checksum mismatch: ${migration.id}`);
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(migration_id,checksum,applied_at) VALUES(?,?,?)")
        .run(migration.id, checksum, new Date(now).toISOString());
      db.exec("COMMIT");
      completed.push(migration.id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return completed;
}

export function migrateControlDatabase(sqlitePath, options = {}) {
  const db = openControlDatabase(sqlitePath);
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity ?? "unknown"}`);
    return { ok: true, applied: applyControlMigrations(db, options) };
  } finally {
    db.close();
  }
}
