# Timeout Reading Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the fixed Language Introduction PDF once when Bilibili or QQ timed access expires, and on every QQ launch attempt during an active cooldown.

**Architecture:** A PowerShell helper manages an atomic event ledger and a user-context scheduled task that opens the PDF. The Bilibili and QQ workers submit verified expiry events. The FocusLock IFEO debugger becomes a guarded wrapper that opens the PDF only for a live QQ cooldown and exits without launching QQ.

**Tech Stack:** PowerShell 7, Windows Task Scheduler, IFEO registry keys, Node SQLite helper, fixture PowerShell tests.

## Global Constraints

- Fixed target: `C:\Users\Mashiroyes\Desktop\语言引论 (弗罗姆金) (z-library.sk, 1lib.sk, z-lib.sk).pdf`.
- One expiry prompt per Bilibili expiry timestamp or QQ session identifier/end timestamp, only after the relevant restriction is active.
- Every QQ launch attempt during active cooldown prompts and remains blocked.
- Permanent/manual restrictions, malformed state, non-timeout failures, and ready sessions do not prompt.
- Preserve FocusLock IFEO backup/restoration semantics.

---

### Task 1: Shared timeout-reading helper

**Files:**
- Create: `focus-lock/TimeoutReadingPrompt.ps1`
- Create: `focus-lock/tests/Test-TimeoutReadingPrompt.ps1`
- Modify: `focus-lock/FocusLock.ps1`

**Interfaces:**
- Consumes `-Mode Open|Submit`, `-EventKey`, `-PdfPath`, `-StateRoot`, `-TaskName`.
- Produces `Submit` JSON: `{ opened, duplicate, eventKey }`.

- [ ] **Step 1: Write failing deduplication fixture**

```powershell
& $helper -Mode Submit -EventKey 'qq:s1:2026-10-01T12:30:00Z' -StateRoot $temp -TaskName $task
& $helper -Mode Submit -EventKey 'qq:s1:2026-10-01T12:30:00Z' -StateRoot $temp -TaskName $task
Assert-Equal 1 $scheduledRuns.Count 'duplicate events must be suppressed'
```

- [ ] **Step 2: Verify the test fails**

Run: `pwsh -NoProfile -File focus-lock/tests/Test-TimeoutReadingPrompt.ps1`

Expected: helper absent or no deduplication behavior.

- [ ] **Step 3: Implement the helper**

Create an atomic JSON ledger under `C:\ProgramData\CodexFocusLock`; first-seen expiry keys call `Start-ScheduledTask -TaskName CodexFocusLock-TimeoutReadingPrompt`. The scheduled task runs as the interactive user and invokes the helper in `Open` mode, which verifies the fixed PDF exists before `Start-Process` opens it. FocusLock deploys both the helper and task.

- [ ] **Step 4: Verify the test passes**

Run: `pwsh -NoProfile -File focus-lock/tests/Test-TimeoutReadingPrompt.ps1`

Expected: repeated event creates exactly one task-run request.

### Task 2: Verified Bilibili and QQ expiry emission

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/install-block.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`

**Interfaces:**
- Consumes installed `C:\ProgramData\CodexFocusLock\TimeoutReadingPrompt.ps1`.
- Produces `bilibili:<expiry>` only after Bilibili blocking layers pass and `qq:<id>:<playEndsAt>` only after the QQ client barrier passes.

- [ ] **Step 1: Write failing worker fixtures**

Advance a Bilibili temporary release through expiry and assert one prompt submission after host/policy reblocking. Advance a QQ session through `playEndsAt`, assert an active client barrier and one QQ key. Repeat reconciliation and assert no extra submissions.

- [ ] **Step 2: Verify fixtures fail**

Run: `pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1; pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`

Expected: no expiry event is emitted.

- [ ] **Step 3: Implement verified submissions**

Workers invoke the shared helper only after their own barrier verification succeeds. They must never submit for a permanent block, manual restore, malformed data, or ordinary deployment reconciliation. Their installers deploy any needed helper dependency and treat a missing helper as failure.

- [ ] **Step 4: Verify focused worker fixtures pass**

Run: `pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1; pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`

Expected: each expiry creates one event; repeats create none.

### Task 3: QQ cooldown IFEO wrapper and production deployment

**Files:**
- Create: `focus-lock/QQCooldownPrompt.ps1`
- Modify: `focus-lock/FocusLock.ps1`
- Test: `focus-lock/tests/Test-TimeoutReadingPrompt.ps1`

**Interfaces:**
- Consumes QQ `last-status.json` containing phase, session cooldown end, and client-barrier state.
- Produces a direct `Open` helper invocation only for a current `cooldown`; exits code 0 without launching QQ.

- [ ] **Step 1: Write failing wrapper fixtures**

Invoke the wrapper with active cooldown, ready, elapsed cooldown, permanent blocked, missing, and malformed status files. Assert exactly the active-cooldown invocation calls the prompt opener.

- [ ] **Step 2: Verify it fails**

Run: `pwsh -NoProfile -File focus-lock/tests/Test-TimeoutReadingPrompt.ps1`

Expected: cooldown guard and wrapper are absent.

- [ ] **Step 3: Implement guarded IFEO migration**

The wrapper parses status defensively, confirms `phase='cooldown'`, a future `cooldownEndsAt`, and an active client barrier, then runs the helper's `Open` mode and exits. FocusLock writes the wrapper debugger for blocked QQ clients, recognizes both old `cmd /d /c exit` and new wrapper debugger as managed values, and restores the saved debugger when QQ is allowed or FocusLock is removed.

- [ ] **Step 4: Run focused regression tests**

Run: `pwsh -NoProfile -File focus-lock/tests/Test-TimeoutReadingPrompt.ps1; pwsh -NoProfile -File focus-lock/tests/Test-BilibiliQQExpiry.ps1; pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`

Expected: all pass; only live cooldown attempts prompt.

- [ ] **Step 5: Deploy and verify**

Run elevated installers, restart affected scheduled workers, compare source/installed SHA-256 values, inspect `CodexFocusLock-TimeoutReadingPrompt` task action and QQ IFEO debugger entries, and collect live FocusLock plus QQ worker status. Do not force a real timeout or open the user's PDF during validation.
