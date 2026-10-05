# QQ Two-Hour Sunday-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow temporary QQ sessions only on Sunday from 12:00 through 22:00, with a fixed 120-minute cooldown after play ends.

**Architecture:** Keep the existing command, database, scheduler, and executable-vault lifecycle. Enforce the Sunday/time window both in the JavaScript command gate and the elevated PowerShell worker, while changing the single canonical cooldown constant used by new sessions; persisted historical deadlines remain untouched.

**Tech Stack:** Node.js ES modules, node:sqlite, PowerShell 7, Windows Task Scheduler

## Global Constraints

- Preserve `玩QQ N分钟` and its 1—60 minute duration range.
- Reject every new session Monday through Saturday in `Asia/Shanghai`.
- On Sunday, retain the 12:00—22:00 window and require the requested play interval to end by 22:00.
- Set only newly activated sessions to `playEndsAt + 120 minutes`; never rewrite stored historical `cooldownEndsAt` values.

---

### Task 1: Canonical eligibility and cooldown

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-parser.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-model.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs`

**Interfaces:**
- Consumes: `canStartQqSession(now, minutes, timeZone)` and `activateQqRequest(request, confirmedAt)`.
- Produces: Sunday-only eligibility and `QQ_COOLDOWN_MINUTES === 120` for all new activations.

- [ ] Add tests for Monday-through-Saturday rejection, Sunday 11:59 rejection, Sunday 12:00 acceptance, Sunday 21:00 plus 60 minutes acceptance, and requests ending after 22:00 rejection.
- [ ] Add model tests expecting 120-minute cooldowns and a stored legacy session whose earlier deadline remains authoritative in `phaseAt`.
- [ ] Run `node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs`; expect failures against the current implementation.
- [ ] Change `canStartQqSession` to require Shanghai weekday `sun`, update rejection constants, and change `QQ_COOLDOWN_MINUTES` from `60` to `120`.
- [ ] Re-run the focused tests and expect all to pass.

### Task 2: Elevated worker defense and user-facing contract

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/index.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs`

**Interfaces:**
- Consumes: the session's stored request time, play duration, and the canonical model copied into the deployed runtime.
- Produces: a second Sunday-only gate before executable restoration, plus accurate bot replies/help.

- [ ] Add worker fixtures proving Saturday is rejected and Sunday within the valid window is accepted without weakening the existing close-boundary cases.
- [ ] Add plugin tests expecting the Monday-through-Saturday rejection reply and the 120-minute cooldown reply.
- [ ] Run the focused JavaScript and PowerShell tests; expect failures before implementation.
- [ ] Add a Sunday check to the worker's Shanghai window assertion and update bot/help text to Sunday-only and 120 minutes.
- [ ] Run all game-timer JavaScript tests and the QQ worker test; expect all to pass.

### Task 3: Production deployment and active-session preservation

**Files:**
- Deploy through: `plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1`
- Runtime root: `C:\ProgramData\MashiroBot\mashirobot-plugin-game-timer-qq`
- Production database: `sqlite/openclaw-planner.sqlite`

**Interfaces:**
- Consumes: tested source files, runtime descriptor, and production SQLite.
- Produces: installed worker/runtime copies and healthy scheduled tasks.

- [ ] Snapshot any active session ID, phase, `play_ends_at`, and `cooldown_ends_at` before installation.
- [ ] Run the elevated installer with the production database and runtime descriptor.
- [ ] Re-read the same active session and prove all four fields are unchanged.
- [ ] Compare SHA-256 hashes for the source/deployed worker, helper, storage, and model files.
- [ ] Run installed status/reconciliation checks, then verify scheduled tasks are ready and the worker status is healthy.
