import fs from "node:fs";
import path from "node:path";
import { openControlDatabase } from "./database.mjs";

export function inspectDatabase(sqlitePath, { backupRoot = path.join(path.dirname(path.resolve(sqlitePath)), "backups") } = {}) {
  const db = openControlDatabase(sqlitePath);
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "unknown";
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    const migrations = db.prepare("SELECT migration_id,applied_at FROM schema_migrations ORDER BY applied_at").all();
    const jobs = db.prepare("SELECT status,COUNT(*) AS count FROM managed_jobs GROUP BY status").all();
    const conflicts = db.prepare("SELECT COUNT(*) AS count FROM operation_journal WHERE state='conflict'").get()?.count ?? 0;
    let latestBackup = null;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, "manifest.json"), "utf8"));
      latestBackup = [...(manifest.backups ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.createdAt ?? null;
    } catch {}
    return { ok: integrity === "ok" && foreignKeyViolations === 0, integrity, foreignKeyViolations, migrationVersion: migrations.at(-1)?.migration_id ?? "none", latestBackup, jobs, operationConflicts: conflicts };
  } finally { db.close(); }
}
