# Desktop QQ Session Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow desktop QQ sessions only from 12:00 through 22:00 Asia/Shanghai.

**Architecture:** Validate the full requested time window in the Node command route before it creates a session. Independently validate the activation time and expected end in the elevated PowerShell worker before it releases FocusLock.

**Tech Stack:** Node.js ESM, node:test, PowerShell 7, Windows Scheduled Tasks.

## Global Constraints

- The allowed interval is `[12:00, 22:00)` Asia/Shanghai; a requested session must end no later than 22:00.
- Reject an overrun request; never silently shorten it.
- Keep QQ website blocks, cooldown rules, historical sessions, and Android controls unchanged.

---

### Task 1: Command gate

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-parser.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/index.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs`

**Interfaces:** `canStartQqSession(now, minutes, timeZone)` returns false before noon, at/after 22:00, and when `now + minutes` exceeds 22:00.

- [ ] Add tests for 11:59:59 rejection, 12:00 acceptance, 21:00 plus 60 minutes acceptance, 21:50 plus 20 minutes rejection, and 22:00 rejection.
- [ ] Update the parser helper to obtain Shanghai calendar parts with `Intl.DateTimeFormat`, validate the request duration against that day's 22:00 deadline, and export a clear after-hours reply.
- [ ] Replace the plugin's noon-only check with the new duration-aware check before preflight, SQLite creation, and scheduler start. Do not let a temporary before-noon release override this daily rule.
- [ ] Run `node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs`.

### Task 2: Elevated worker gate

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`

**Interfaces:** A `Test-QQSessionWindow` PowerShell helper uses `$clock` and `session.playMinutes`; it throws before `Db 'activate64'`, `Authorize`, or `Apply-Focus` when activation would be out of window.

- [ ] Add fixture sessions that try to activate at 22:00 and at 21:50 for 20 minutes; assert failure, inactive authorization, and active client barrier.
- [ ] Use `China Standard Time` to calculate the current day 12:00/22:00 boundaries; reject pre-noon, at/after 22:00, and any expected end after 22:00.
- [ ] Run `pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`.

### Task 3: Deployment and proof

**Files:**
- Verify: `plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1`
- Verify: `C:\ProgramData\MashiroBot\mashirobot-plugin-game-timer\qq\workers\qq-session-worker-v1.ps1`

- [ ] Confirm the installer copies the guarded worker source to the active `C:\ProgramData` runtime.
- [ ] Read runtime status first. If no real QQ session is playing, run the supported installer update, compare source/deployed hashes, and inspect live protected-state status.
- [ ] Run the focused Node and PowerShell regression suites. Report static boundary proof separately from any live in-window launch that was not performed.
