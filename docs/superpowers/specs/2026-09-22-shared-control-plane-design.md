# MashiroBot Shared Control Plane Design

## Scope

This design implements recommendations 1 through 8 only. It unifies reminders, acknowledgement, scheduled-job state, reversible external operations, game-timer controls, blocking safeguards, and SQLite recovery. Credential storage, generic undo, reminder-frequency tuning, disk severity levels, broad diagnostics, aggregate task views, and the general risk-policy framework remain outside this change.

Existing uncommitted work in the repository must be preserved. The migration is additive and keeps current user commands working unless this design explicitly expands them.

## Chosen approach

Add a shared control plane under `core/control` and migrate existing plugins onto it incrementally. SQLite is the authoritative state store. Windows Task Scheduler remains a wake-up and process-launch mechanism, never the source of truth. Existing plugin business tables remain in place while shared tables provide cross-plugin coordination.

A full rewrite was rejected because it would combine business-behaviour changes with runtime replacement and make rollback unsafe. Per-plugin patches without shared infrastructure were rejected because they would preserve the duplicated reminder, job, and recovery rules that caused the problem.

## Shared modules

### CommandRouter

The existing core plugin router remains responsible for plugin discovery and precedence. A new system-command layer runs before plugin routing and handles only shared commands:

- `暂停提醒30分钟`
- `今晚静默`
- `恢复提醒`
- `查看当前提醒`
- `收到`, `收到了`, `知道了`, `不用提醒了`
- `收到 R241` and equivalent acknowledgement phrases with a reminder ID
- `数据库自检`

Plugins continue to own business commands. This avoids a second general-purpose routing system while giving shared controls a single unambiguous entry point.

### ReminderManager

All proactive reminder producers register a reminder before sending. A reminder has a stable UUID, human short ID, source plugin, kind, priority, content, acknowledgement requirement, deduplication key, status, due time, expiry, and optional source record reference.

Priority order is:

1. wake-up alarm
2. critical disk warning
3. user-created reminder
4. plan reminder
5. habit reminder, including sleep and loot
6. statistics delivery

The manager enforces global pause and tonight-silent state. Critical wake-up alarms bypass ordinary pause and silence. Due low-priority reminders within the same dispatch window are combined into one message while retaining their individual short IDs. Producers use a common PowerShell dispatch helper so Windows-triggered messages follow the same policy as messages initiated through Node.

Acknowledgement is safe under concurrency. If exactly one acknowledgement-required reminder is waiting, a natural acknowledgement phrase confirms it. If more than one is waiting, an ID is required and the bot lists the valid IDs. Acknowledging a shared reminder calls the source-specific completion adapter when required, then marks the reminder acknowledged.

### JobManager

Every managed scheduled job is represented in SQLite with `job_id`, `version`, owner, kind, desired run time, payload, expected Windows task name, and status. Each Windows invocation carries both job ID and version and claims the job before doing work. Missing, cancelled, completed, or stale versions exit without side effects.

Reconciling compares desired jobs with Windows tasks that use MashiroBot-owned prefixes. It recreates missing tasks and removes orphaned or stale tasks only within those prefixes. Reconciliation runs during MashiroBot startup and is available to installers and health checks. Recurring calendar tasks use the same registry, with their recurrence definition stored as job payload.

### OperationJournal

External changes that may be interrupted use an operation record with operation ID, owner, operation kind, target, source and destination, expected SHA-256, state, timestamps, and sanitized error. Valid transitions are explicit: `prepared`, `applying`, `applied`, `reverting`, `reverted`, `conflict`, and `failed`.

Game executable protection writes `prepared` before moving, `applied` after the move is verified, and `reverted` after verified restoration. Startup recovery inspects unfinished records and filesystem state, then either completes the safe transition or records a conflict without overwriting files. `恢复所有游戏文件` invokes the recovery path directly and is intentionally outside blocking enforcement.

Block-system Hosts, browser policy, and Clash operations record journal entries around synchronization. The existing state files remain compatibility evidence during migration, but new operations are recoverable and visible in SQLite.

## Game timer controls

Each timer gets a short ID such as `G18`, unique among active and recent timers. Supported commands are:

- `查询游戏计时`
- `取消游戏计时` or `取消 G18`
- `延长30分钟` or `延长 G18 30分钟`
- `立即结束计时` or `立即结束 G18`
- `恢复所有游戏文件`

When only one active timer exists, commands may omit the ID. With multiple active timers the bot requests a specific ID. Cancel removes both scheduled tasks and marks the SQLite task cancelled. Extend creates a new task version and replaces both Windows tasks. Immediate end cancels future reminders and invokes the existing close/force path deliberately; the response states whether normal close or force was used. Starting a timer returns its short ID and exact reminder, force, and lock times.

## Blocking safeguards

An immutable allowlist protects MashiroBot/OpenClaw executables and directories, PowerShell and configured Python/Node runtimes, the recovery worker, WeChat delivery components, Clash local management endpoints, loopback addresses, and the repository/runtime locations required for recovery.

Rules that target an allowlisted resource are rejected. Broad website patterns, core infrastructure names, and permanent restrictions enter a pending-confirmation record and return an impact preview. They are not applied until the user sends the rule-specific confirmation. Ordinary narrow temporary restrictions retain direct execution.

## Database lifecycle

The shared database bootstrap always enables `foreign_keys=ON`, `journal_mode=WAL`, and `busy_timeout=5000`. A `schema_migrations` table records ordered, immutable migration IDs and checksums. Migrations run inside transactions only after WAL checkpoint, integrity check, and a recoverable backup.

Automated backups use a manifest and rotation policy: retain one backup for each of the latest seven Shanghai calendar days and one weekly backup for each of the latest four weeks. Backups contain the database plus WAL/SHM when present and never contain credentials or full debug logs. `数据库自检` reports integrity, foreign-key violations, migration version, latest backup, job reconciliation summary, and open operation conflicts without printing message bodies, sensitive paths, or tokens.

## Migration and compatibility

Shared tables are additive. Existing plan, reminder, game, block, loot, and English tables remain authoritative for their business data. Adapters register or mirror their active work into the shared tables. Existing workers gain a shared preflight step rather than being replaced at once.

Existing exact commands continue to work. Natural acknowledgement phrases are additive. The old exact `收到` route delegates to ReminderManager. Existing game timer rows receive deterministic short IDs and version 1 during migration.

Relative general reminders accept both minute and hour units, including `3分钟后提醒我吃饭`, `30分后提醒我休息`, and the existing `8h后提醒我吃饭` form. These commands must remain entirely local and must not fall through to GPT authentication.

## Historical cleanup

After the new migration and backup system is verified, remove redundant historical database snapshots and obsolete code copies. Cleanup is evidence-based: resolve every target under the repository or an explicitly named MashiroBot runtime directory, confirm it is not referenced by source, installed tasks, or the active runtime, and keep the current production database plus the retention set produced by the new backup policy. Versioned files such as `worker-v1` or `runtime-v1` are names, not automatic deletion candidates; referenced versions stay. Generated compiler output and superseded unreferenced copies may be removed. A manifest records each removed path, reason, size, and whether Git or the retained backup set can recover it.

## Error handling

- A reminder that cannot be registered is not sent outside the manager; the producer records a failure.
- A stale job invocation exits successfully with no user-visible message.
- Reconciliation never touches tasks outside explicit MashiroBot/OpenClaw managed prefixes.
- Operation recovery never overwrites an occupied original path; it records a conflict and tells the user which recovery command to run.
- Migration or integrity-check failure leaves the old schema and files unchanged.
- Logs contain IDs, state transitions, and sanitized errors, not reminder content or complete local paths.

## Verification

Implementation will minimize intermediate execution. After all eight areas are connected, one consolidated verification pass will cover:

- shared module unit tests;
- core router and plugin regression tests;
- plan, loot, language, game-timer, block, and PowerShell worker tests;
- migration against a copied production database;
- dry-run Windows task reconciliation and stale-version rejection;
- operation-journal crash-state recovery fixtures;
- final health check and documentation consistency.

No test may send a real WeChat message, play audio, terminate a real application, edit the real Hosts file, or move a real game executable.
