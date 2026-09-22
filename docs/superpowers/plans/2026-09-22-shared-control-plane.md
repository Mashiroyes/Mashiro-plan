# MashiroBot Shared Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement recommendations 1-8 by giving MashiroBot one authoritative reminder, job, operation-recovery, and database lifecycle layer while adding safe game-timer and blocking controls.

**Architecture:** Add shared SQLite-backed services under `core/control`, route shared commands before plugin commands, and adapt existing Node and PowerShell producers without replacing their business tables. SQLite owns desired state; Windows Task Scheduler and filesystem/policy workers become version-checked executors with recovery journals.

**Tech Stack:** Node.js ESM, `node:sqlite`, Python SQLite compatibility, PowerShell 7, Windows Task Scheduler, Node test runner, Pester-style PowerShell scripts.

## Global Constraints

- Preserve all existing uncommitted work and user data.
- Implement recommendations 1 through 8 only, plus evidence-based cleanup requested afterward.
- Keep existing user commands compatible while adding shared commands.
- Do not send real WeChat messages, play audio, terminate applications, edit real Hosts/policies, or move real game files during tests.
- Run only lightweight syntax/static checks during implementation; run the consolidated suite after all tasks are implemented.
- Never delete a versioned worker or runtime merely because its name contains `v1` or `v2`; prove it is unreferenced first.

---

### Task 1: Shared database lifecycle and migrations

**Files:**
- Create: `core/control/database.mjs`
- Create: `core/control/migrations.mjs`
- Create: `core/control/backup-manager.mjs`
- Create: `core/control/database-health.mjs`
- Test: `tests/control-database.test.mjs`

**Interfaces:**
- Produces: `openControlDatabase(sqlitePath)`, `migrateControlDatabase(sqlitePath)`, `createRotatingBackup(options)`, `inspectDatabase(sqlitePath)`.
- Creates: `schema_migrations`, `reminder_control_state`, `managed_reminders`, `managed_jobs`, `operation_journal`, and `pending_high_risk_actions`.

- [ ] Implement one transaction-safe bootstrap that enables foreign keys, WAL, and busy timeout.
- [ ] Implement immutable numbered migrations with checksums and pre-migration integrity/backup gates.
- [ ] Implement daily-seven and weekly-four backup retention with a JSON manifest.
- [ ] Implement sanitized database health output.

### Task 2: ReminderManager and shared commands

**Files:**
- Create: `core/control/reminder-manager.mjs`
- Create: `core/control/system-command-router.mjs`
- Modify: `core/index.mjs`
- Modify: `core/router/plugin-router.mjs`
- Test: `tests/reminder-manager.test.mjs`
- Test: `tests/system-command-router.test.mjs`

**Interfaces:**
- Produces: `createReminderManager({ sqlitePath, now })` with `register`, `claimDue`, `finishDelivery`, `listCurrent`, `acknowledge`, `pause`, `silenceTonight`, and `resume`.
- Produces: `createSystemCommandRouter({ reminderManager, inspectDatabase })`.

- [ ] Implement priorities, stable `Rnnn` IDs, deduplication, pause/silence, critical bypass, and low-priority combination.
- [ ] Implement natural acknowledgement phrases with ID-required ambiguity handling.
- [ ] Route shared commands before plugins while preserving help-menu behavior.
- [ ] Expose `数据库自检` without sensitive message content or full local paths.

### Task 3: Common Windows reminder dispatch

**Files:**
- Create: `core/control/windows/reminder-dispatch.ps1`
- Create: `core/control/reminder-cli.mjs`
- Modify: `plugin/mashirobot-plugin-plan/windows/reminder-common.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/plan-reminder-worker.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/routine-reminder.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/check-disk-space.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/english-skills-worker.ps1`
- Modify: `plugin/mashirobot-plugin-loot/windows/loot-worker.ps1`

**Interfaces:**
- Consumes: ReminderManager database schema and CLI.
- Produces: PowerShell `Invoke-ManagedReminder` that registers, claims, sends, and records delivery.

- [ ] Make plan, general, routine, disk, English, and loot proactive messages pass through the common dispatcher.
- [ ] Keep wake-up reminders at highest priority and allow them to bypass pause/silence.
- [ ] Preserve source-specific acknowledgement and completion behavior through source references.
- [ ] Extend relative general reminders to accept integer minute forms such as `3分钟后提醒我吃饭` without GPT fallback.

### Task 4: JobManager and scheduler reconciliation

**Files:**
- Create: `core/control/job-manager.mjs`
- Create: `core/control/job-cli.mjs`
- Create: `core/control/windows/job-reconcile.ps1`
- Modify: `core/index.mjs`
- Modify: `plugin/mashirobot-plugin-plan/windows/manage-plan.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1`
- Modify: `plugin/mashirobot-plugin-loot/windows/install.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/core/scheduler.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/powershell/install-game-timer.ps1`
- Test: `tests/job-manager.test.mjs`

**Interfaces:**
- Produces: `createJobManager({ sqlitePath })` with `upsertDesired`, `claim`, `complete`, `cancel`, `listDesired`, and `reconcile`.
- Every worker consumes `jobId` and `jobVersion` and exits with `stale-or-inactive` before side effects when claim fails.

- [ ] Register desired jobs in SQLite before creating Windows tasks.
- [ ] Pass job identity/version into task actions and validate at worker start.
- [ ] Implement prefix-scoped dry-run and live reconciliation.
- [ ] Run startup reconciliation asynchronously without blocking message routing.

### Task 5: Game timer lifecycle controls

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/parser.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/core/storage.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/core/scheduler.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/index.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/powershell/game-timer-worker-v1.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/tests/plugin.test.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/tests/test-worker.ps1`

**Interfaces:**
- Adds timer `short_id` and `version`.
- Adds commands `查询游戏计时`, `取消游戏计时`, `取消 G18`, `延长30分钟`, `延长 G18 30分钟`, `立即结束计时`, and `立即结束 G18`.

- [ ] Migrate existing timer rows to deterministic short IDs and version 1.
- [ ] Add single-active implicit targeting and multi-active ambiguity response.
- [ ] Implement cancel by removing both tasks then atomically changing state.
- [ ] Implement extend as a new job version and replacement task pair.
- [ ] Implement immediate end through the existing verified close/force path.

### Task 6: OperationJournal and game-file recovery

**Files:**
- Create: `core/control/operation-journal.mjs`
- Create: `core/control/operation-cli.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/core/game-vault-storage.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/game-locker/powershell/game-locker-worker-v1.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/index.mjs`
- Test: `tests/operation-journal.test.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/game-locker/tests/test-game-locker-worker.ps1`

**Interfaces:**
- Produces: `createOperationJournal(sqlitePath)` with `prepare`, `transition`, `listOpen`, and `recoverFilesystemMove`.
- Adds command `恢复所有游戏文件`, routed before block enforcement.

- [ ] Journal original path, protected path, SHA-256, task/rule ID, and every transition.
- [ ] Recover `prepared/applying/applied/reverting` states by inspecting both paths and hash.
- [ ] Never overwrite an occupied original path; record `conflict`.
- [ ] Run recovery on startup and expose an explicit all-games recovery command.

### Task 7: Blocking allowlist and confirmation

**Files:**
- Create: `plugin/mashirobot-plugin-game-timer/block/core/protected-targets.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/core/parser.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/core/storage.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/index.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/block/tests/plugin.test.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`

**Interfaces:**
- Produces: `classifyBlockRisk(command, machineConfig)` returning `reject`, `confirm`, or `direct` plus a sanitized impact preview.
- Stores rule-specific pending confirmations in `pending_high_risk_actions`.

- [ ] Reject restrictions against recovery-critical processes, paths, loopback endpoints, and control components.
- [ ] Require confirmation for permanent and broad restrictions.
- [ ] Bind confirmation to one action ID and expiry; never use an unscoped generic confirmation.
- [ ] Add journal transitions around Hosts, browser policy, and Clash synchronization.

### Task 8: Documentation, cleanup, and consolidated verification

**Files:**
- Modify: `README.md`
- Modify: affected plugin `README.md` and help data
- Create: `docs/cleanup-manifest-2026-09-22.json`
- Modify: relevant test suites

**Interfaces:**
- Produces: documented commands, verified active runtime map, cleanup manifest, and final health evidence.

- [ ] Update command help and architecture documentation for all shared controls.
- [ ] Inventory backup/code-copy candidates, current scheduled-task action paths, source references, and Git tracking.
- [ ] Retain the production database, active runtimes/workers, and the new seven-daily/four-weekly backup set.
- [ ] Delete only proven unreferenced generated output, obsolete code copies, and redundant backups; record every target and recovery source.
- [ ] Run the complete Node, Python, and safe PowerShell test suites once.
- [ ] Run copied-production migration, database health, dry-run reconciliation, and operation-recovery fixtures.
- [ ] Repair failures, rerun affected suites, and complete a requirement-by-requirement audit for recommendations 1-8.
