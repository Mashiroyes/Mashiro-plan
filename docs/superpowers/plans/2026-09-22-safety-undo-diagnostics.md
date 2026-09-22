# MashiroBot Safety, Undo, and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement recommendations 10-15 with truthful undo, lower-noise habits, escalating disk alerts, unified diagnostics/help/status, and consistent risk handling. Recommendation 9 is excluded in full per the user's later migration decision.

**Architecture:** Extend `core/control` with focused services and adapters. Keep business data in existing plugin stores, credentials outside SQLite, and recovery ownership inside the plugin that caused the effect.

**Tech Stack:** Node.js ESM, `node:sqlite`, PowerShell 7, Windows Task Scheduler, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-22-safety-undo-diagnostics-design.md`

## Global Constraints

- Preserve all existing uncommitted work and user data.
- Never print or persist plaintext credentials in SQLite or logs.
- Never describe an irreversible external side effect as undone.
- Do not perform live message delivery, process termination, policy edits, or executable moves in tests.

---

### Task 1: Reversible operation journal and command

**Files:** Create `core/control/undo-manager.mjs`; modify `core/control/migrations.mjs`, `core/control/system-command-router.mjs`, and initial plugin adapters; test `tests/undo-manager.test.mjs`.

**Interfaces:** `createUndoManager({sqlitePath, handlers, now}).record/undoLatest/list`, scoped by account/conversation and carrying a typed inverse payload.

- [ ] Test latest-selection, scope, expiry, single-use, failure retry, and non-reversible rejection.
- [ ] Implement schema and manager transaction boundaries.
- [ ] Register plan-version, reminder, keyword, and game-timer inverse handlers.
- [ ] Route `撤销上一操作` and return recovery guidance for the latest non-reversible operation.

### Task 2: Habit dismissal and frequency

**Files:** Modify loot installer/help/tests and plan routine route/worker/tests.

**Interfaces:** Loot schedule `21:15,21:50`; sleep commands `今晚不再提醒`, `延迟30分钟` store a routine-date dismissal/defer state.

- [ ] Write route and installer tests for two loot triggers and sleep-only dismissal/defer.
- [ ] Implement and update help text.
- [ ] Run loot and plan route/PowerShell dry-run tests.

### Task 3: Tiered disk alerts

**Files:** Modify `plugin/mashirobot-plugin-plan/windows/check-disk-space.ps1` and its PowerShell/runtime-state tests.

**Interfaces:** State key `disk-space:severity-v1`; severity `ordinary|serious|urgent`; message includes `free / total` and percent free.

- [ ] Add deterministic drive fixtures for same-level suppression and same-day escalation.
- [ ] Implement severity selection and per-drive last-notified level/date.
- [ ] Verify `<20`, `<10`, and `<5` GB boundaries with dry-run delivery.

### Task 4: Unified diagnostics and current task

**Files:** Create `core/control/system-diagnostics.mjs`, `core/control/current-tasks.mjs`; modify `core/index.mjs`, `core/control/system-command-router.mjs`; test both services.

**Interfaces:** `runSystemDiagnostics(options)` and `collectCurrentTasks(providers)` return sanitized structured sections with `ok|failed|unknown`.

- [ ] Test every required diagnostic category and sanitization.
- [ ] Implement read-only checks and concrete repair hints.
- [ ] Implement providers for plan, reminders, game timers, releases, and sleep state.
- [ ] Route `自检` and `当前任务`.

### Task 5: Help aliases and risk policy

**Files:** Create `core/control/risk-policy.mjs`; modify router/help manifests and game/block command paths; test aliases and risk levels.

**Interfaces:** `classifyRisk(action)` returns `direct|undoable|confirm` plus impact/recovery metadata.

- [ ] Test `提醒帮助`, `游戏帮助`, `禁止帮助`, and `英语帮助` routing.
- [ ] Centralize confirmation storage/expiry for high-risk actions while retaining action-bound IDs.
- [ ] Ensure low-risk temporary restrictions execute directly and medium-risk mutations create undo entries.

### Task 6: Consolidated verification and deployment

**Files:** Update README/plugin help and affected deployment scripts.

- [ ] Run focused Node and PowerShell tests, then the full repository suites.
- [ ] Install updated loot/sleep/disk tasks and read back their triggers/actions.
- [ ] Run SQLite integrity check, read-only `自检`, and stubbed route checks for `撤销上一操作`, `当前任务`, and help aliases.
- [ ] Record any environment-only check as `未核验`; do not report it as passed.
