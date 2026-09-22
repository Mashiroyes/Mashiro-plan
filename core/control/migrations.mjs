import { createHash } from "node:crypto";

export const CONTROL_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: "20260922-001-control-plane",
    sql: `
      CREATE TABLE IF NOT EXISTS reminder_control_state (
        scope TEXT PRIMARY KEY,
        paused_until TEXT,
        silent_until TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_reminders (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL UNIQUE,
        source_plugin TEXT NOT NULL,
        kind TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 6),
        content TEXT NOT NULL,
        requires_ack INTEGER NOT NULL DEFAULT 0 CHECK(requires_ack IN (0,1)),
        dedupe_key TEXT,
        source_ref TEXT,
        due_at TEXT NOT NULL,
        expires_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','acknowledged','suppressed','failed','cancelled')),
        last_sent_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_reminder_dedupe_open
        ON managed_reminders(source_plugin,dedupe_key)
        WHERE dedupe_key IS NOT NULL AND status IN ('pending','sending','sent');
      CREATE INDEX IF NOT EXISTS idx_managed_reminder_due
        ON managed_reminders(status,due_at,priority);
      CREATE TABLE IF NOT EXISTS managed_jobs (
        job_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version > 0),
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_name TEXT NOT NULL UNIQUE,
        run_at TEXT,
        recurrence_json TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('desired','running','completed','cancelled','failed')),
        claimed_at TEXT,
        completed_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_managed_jobs_status ON managed_jobs(status,run_at);
      CREATE TABLE IF NOT EXISTS operation_journal (
        operation_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_key TEXT NOT NULL,
        source_path TEXT,
        destination_path TEXT,
        expected_sha256 TEXT,
        rule_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('prepared','applying','applied','reverting','reverted','conflict','failed')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_journal_open ON operation_journal(state,owner);
      CREATE TABLE IF NOT EXISTS pending_high_risk_actions (
        action_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        impact_summary TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  }),
  Object.freeze({
    id: "20260922-002-close-fire-and-forget-reminders",
    sql: `
      UPDATE managed_reminders
      SET status='acknowledged', updated_at=COALESCE(last_sent_at,updated_at)
      WHERE status='sent' AND requires_ack=0;
    `,
  }),
  Object.freeze({
    id: "20260922-003-undo-journal",
    sql: `
      CREATE TABLE IF NOT EXISTS undo_journal (
        undo_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        owner TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        description TEXT NOT NULL,
        inverse_payload_json TEXT,
        reversible INTEGER NOT NULL CHECK(reversible IN (0,1)),
        recovery_command TEXT,
        status TEXT NOT NULL CHECK(status IN ('available','applying','undone','failed','expired')),
        expires_at TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_undo_scope_latest ON undo_journal(scope,status,created_at DESC);
    `,
  }),
]);

export function migrationChecksum(migration) {
  return createHash("sha256").update(`${migration.id}\0${migration.sql}`, "utf8").digest("hex");
}
