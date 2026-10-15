import { randomUUID } from "node:crypto";
import { applyControlMigrations, openControlDatabase } from "./database.mjs";

function map(row) {
  if (!row) return null;
  return { jobId: row.job_id, version: row.version, owner: row.owner, kind: row.kind, taskName: row.task_name, runAt: row.run_at, recurrence: row.recurrence_json ? JSON.parse(row.recurrence_json) : null, payload: JSON.parse(row.payload_json), status: row.status, claimedAt: row.claimed_at, completedAt: row.completed_at, error: row.error };
}

export function createJobManager({ sqlitePath, now = () => new Date() }) {
  const withDb = (callback) => { const db = openControlDatabase(sqlitePath); try { applyControlMigrations(db); return callback(db); } finally { db.close(); } };
  const iso = () => new Date(now()).toISOString();
  return Object.freeze({
    upsertDesired(input) {
      return withDb((db) => {
        const at = iso();
        const existing = input.jobId ? db.prepare("SELECT * FROM managed_jobs WHERE job_id=?").get(input.jobId) : null;
        const jobId = input.jobId ?? randomUUID();
        const version = input.version ?? (existing ? existing.version + 1 : 1);
        db.prepare(`INSERT INTO managed_jobs(job_id,version,owner,kind,task_name,run_at,recurrence_json,payload_json,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?, 'desired',?,?)
          ON CONFLICT(job_id) DO UPDATE SET version=excluded.version,owner=excluded.owner,kind=excluded.kind,task_name=excluded.task_name,run_at=excluded.run_at,recurrence_json=excluded.recurrence_json,payload_json=excluded.payload_json,status='desired',claimed_at=NULL,completed_at=NULL,error=NULL,updated_at=excluded.updated_at`)
          .run(jobId, version, input.owner, input.kind, input.taskName, input.runAt ? new Date(input.runAt).toISOString() : null, input.recurrence ? JSON.stringify(input.recurrence) : null, JSON.stringify(input.payload ?? {}), at, at);
        return map(db.prepare("SELECT * FROM managed_jobs WHERE job_id=?").get(jobId));
      });
    },
    claim(jobId, version) {
      return withDb((db) => {
        const at = iso();
        const changed = db.prepare("UPDATE managed_jobs SET status='running',claimed_at=?,updated_at=? WHERE job_id=? AND version=? AND status='desired'").run(at, at, jobId, Number(version));
        if (changed.changes !== 1) return { claimed: false, reason: "stale-or-inactive" };
        return { claimed: true, job: map(db.prepare("SELECT * FROM managed_jobs WHERE job_id=?").get(jobId)) };
      });
    },
    complete(jobId, version, { ok = true, error = null, recurring = false } = {}) {
      return withDb((db) => {
        const at = iso();
        const status = recurring && ok ? "desired" : ok ? "completed" : "failed";
        const changed = db.prepare("UPDATE managed_jobs SET status=?,completed_at=?,error=?,updated_at=? WHERE job_id=? AND version=? AND status='running'").run(status, at, ok ? null : String(error ?? "job failed").slice(0, 500), at, jobId, Number(version));
        return { updated: changed.changes === 1 };
      });
    },
    cancel(jobId) { return withDb((db) => db.prepare("UPDATE managed_jobs SET status='cancelled',version=version+1,updated_at=? WHERE job_id=? AND status NOT IN ('completed','cancelled')").run(iso(), jobId).changes === 1); },
    cancelByTaskName(taskName) { return withDb((db) => db.prepare("UPDATE managed_jobs SET status='cancelled',version=version+1,updated_at=? WHERE task_name=? AND status NOT IN ('completed','cancelled')").run(iso(), taskName).changes); },
    get(jobId) { return withDb((db) => map(db.prepare("SELECT * FROM managed_jobs WHERE job_id=?").get(jobId))); },
    listDesired() { return withDb((db) => db.prepare("SELECT * FROM managed_jobs WHERE status IN ('desired','running') ORDER BY task_name").all().map(map)); },
    expirePastOneShot({ before = now() } = {}) {
      const at = new Date(before).toISOString();
      return withDb((db) => db.prepare(`UPDATE managed_jobs
        SET status='failed',completed_at=?,error='expired before task reconciliation',updated_at=?
        WHERE status IN ('desired','running')
          AND recurrence_json IS NULL
          AND run_at IS NOT NULL
          AND run_at<?`).run(at, at, at).changes);
    },
    recoverStale({ olderThanMinutes = 30 } = {}) {
      const cutoff = new Date(new Date(now()).getTime() - Number(olderThanMinutes) * 60_000).toISOString();
      return withDb((db) => db.prepare("UPDATE managed_jobs SET status='desired',claimed_at=NULL,error='recovered stale claim',updated_at=? WHERE status='running' AND claimed_at<?").run(iso(), cutoff).changes);
    },
    reconcile(actualTasks, { managedPrefixes = ["OpenClaw-", "MashiroBot ", "MashiroBot-"] } = {}) {
      const desired = this.listDesired();
      const actual = new Map(actualTasks.filter((task) => managedPrefixes.some((prefix) => task.taskName.startsWith(prefix))).map((task) => [task.taskName, task]));
      const desiredNames = new Set(desired.map((job) => job.taskName));
      return { missing: desired.filter((job) => !actual.has(job.taskName)), orphaned: [...actual.values()].filter((task) => !desiredNames.has(task.taskName)), valid: desired.filter((job) => actual.has(job.taskName)) };
    },
  });
}
