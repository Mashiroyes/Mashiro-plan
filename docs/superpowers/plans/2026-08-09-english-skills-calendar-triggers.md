# English Skills Calendar Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace daily polling with direct weekly, monthly, and yearly Windows calendar tasks.

**Architecture:** The worker receives one explicit period type and calculates the last fully completed matching period. The installer creates three native Task Scheduler triggers, verifies them, and then removes the legacy daily task.

**Tech Stack:** PowerShell 7, Windows Task Scheduler CIM classes, WScript hidden launcher, Python/SQLite worker backend.

## Global Constraints

- Ordinary days launch no English dashboard worker.
- All tasks run at 11:00 Asia/Shanghai with `StartWhenAvailable` and `WakeToRun`.
- Catch-up runs calculate the same period as the missed trigger.
- Existing charts, Weixin delivery, and SQLite idempotency remain unchanged.

---

### Task 1: Explicit worker period

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/windows/english-skills-worker.ps1`
- Test: `plugin/mashirobot-plugin-plan/tests/test_english_skills_windows.ps1`

**Interfaces:**
- Consumes `-PeriodType week|month|year` and optional `-Now`.
- Produces exactly one due period whose range is the last completed matching calendar period.

- [ ] Add failing assertions for Tuesday weekly catch-up, day-2 monthly catch-up, and January-2 yearly catch-up.
- [ ] Run the PowerShell test and confirm the explicit-period cases fail.
- [ ] Add the validated `PeriodType` parameter and period-specific range calculation.
- [ ] Run the focused test and confirm all period cases pass.

### Task 2: Native calendar tasks and migration

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/run-hidden-worker.vbs`
- Modify: `plugin/mashirobot-plugin-plan/README.md`
- Test: `plugin/mashirobot-plugin-plan/tests/test_english_skills_windows.ps1`

**Interfaces:**
- Produces three tasks named `MashiroBot English Skills Weekly`, `Monthly`, and `Yearly`.
- Removes `MashiroBot English Skills Dashboard` after new-task verification.

- [ ] Extend the hidden launcher to forward a fifth period-type argument.
- [ ] Create weekly and monthly Task Scheduler CIM trigger objects with exact 11:00 start boundaries.
- [ ] Register the three actions with explicit period types and shared safe settings.
- [ ] Verify task class, calendar mask, action path, period argument, and Ready state before removing the legacy task.
- [ ] Run isolated install/uninstall tests and confirm no test task remains.

### Task 3: Formal replacement and audit

**Files:**
- Modify only files implicated by verification failures.

**Interfaces:**
- Consumes the verified installer and proves live behavior.

- [ ] Install the immutable runtime and three formal tasks against the live SQLite database.
- [ ] Prove the legacy daily task is absent and all three new tasks are Ready.
- [ ] Manually start all three tasks, wait for completion, and require result 0.
- [ ] Compare runtime/source hashes, run SQLite integrity check, and confirm the OpenClaw gateway remains online.

