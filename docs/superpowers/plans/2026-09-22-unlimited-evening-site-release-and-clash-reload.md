# Unlimited Evening Site Release and Clash Reload Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the evening website-release quota ceiling and make block synchronization recover when both Clash hot-reload transports fail.

**Architecture:** Model the evening quota explicitly as unbounded while retaining the existing period splitter and transaction logic. Extend the PowerShell worker's reload sequence with a bounded `verge-mihomo` restart fallback that verifies the process returns before declaring synchronization successful.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite`, PowerShell 7, Windows Scheduled Tasks, Clash Verge/Mihomo.

## Global Constraints

- Morning remains limited to 20 minutes.
- Afternoon remains limited to 30 minutes.
- Evening has no release quota ceiling.
- Per-website accounting, overlap deduplication, cross-period splitting, and whole-request rejection remain intact.
- QQ, game timers, and unrelated FocusLock behavior remain unchanged.
- Reload recovery remains bounded and fails closed when Mihomo does not return.

---

### Task 1: Unlimited evening quota

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/core/release-quota.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/tests/storage.test.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/index.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/block/tests/storage.test.mjs`

**Interfaces:**
- Consumes: `evaluateReleaseQuota({ intervals, proposedStart, proposedEnd })`.
- Produces: quota period objects whose `limitMinutes` and `remainingMinutes` are `null` for unbounded evening periods.

- [ ] **Step 1: Add failing evening quota tests**

Add tests that request 180 minutes starting at 19:00 Shanghai and assert `allowed === true`, `label === "晚上"`, `limitMinutes === null`, and `remainingMinutes === null`. Add a 17:50–18:40 Shanghai request after 25 afternoon minutes have already been consumed and assert the entire request is rejected because its afternoon portion exceeds 30 minutes even though evening is unlimited.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
node --test plugin/mashirobot-plugin-game-timer/block/tests/storage.test.mjs
```

Expected: the evening request is rejected or reports a numeric 30-minute limit.

- [ ] **Step 3: Implement explicit unbounded evening quota**

Change the evening band to `limitMinutes: null`. In `evaluateReleaseQuota`, calculate bounded remaining minutes only when `Number.isFinite(period.limitMinutes)`; otherwise return `remainingMinutes: null`. Define `allowed` as every period being unbounded or having nonnegative remaining minutes.

- [ ] **Step 4: Update user-facing quota text and help**

In `index.mjs`, render a period with `remainingMinutes === null` as `晚上不限额`, keep the rejection filter limited to numeric negative remaining values, and change help text from `晚上30分钟` to `晚上不限额`.

- [ ] **Step 5: Run block storage and handler tests**

Run:

```powershell
node --test plugin/mashirobot-plugin-game-timer/block/tests/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```powershell
git add plugin/mashirobot-plugin-game-timer/block/core/release-quota.mjs plugin/mashirobot-plugin-game-timer/block/tests/storage.test.mjs plugin/mashirobot-plugin-game-timer/block/index.mjs
git commit -m "feat: remove evening website release quota"
```

### Task 2: Mihomo restart fallback

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`

**Interfaces:**
- Consumes: `Invoke-ClashReload([string]$configPath)`.
- Produces: `{ Ok, Method, Error }`, where `Method` is `http`, `pipe`, or `restart` on success.

- [ ] **Step 1: Add failing worker source assertions**

Extend `test-worker.ps1` to require `function Invoke-ClashProcessRestart`, a bounded restart timeout constant, `Stop-Process -Force`, and verification that a new `verge-mihomo` process is running before success.

- [ ] **Step 2: Run the worker test and verify failure**

Run:

```powershell
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
```

Expected: failure because the restart fallback does not exist.

- [ ] **Step 3: Implement bounded restart fallback**

Add `Invoke-ClashProcessRestart` that records current Mihomo process IDs, stops them with `Stop-Process -Force`, waits up to 10 seconds, and succeeds only when a running `verge-mihomo` process with a new ID appears. Call it after the HTTP and pipe retry budget is exhausted. Return `Method='restart'` when successful; otherwise include HTTP, pipe, and restart errors in the final error.

- [ ] **Step 4: Preserve pending-state semantics**

Keep `ClashReloadPending=false` for any successful reload method and `true` only when all three methods fail. Do not alter Hosts, browser policy, QQ, or database logic.

- [ ] **Step 5: Run the PowerShell worker test**

Run:

```powershell
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
```

Expected: JSON containing `"ok":true`.

- [ ] **Step 6: Commit**

```powershell
git add plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1 plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
git commit -m "fix: recover Clash reload by restarting Mihomo"
```

### Task 3: Deploy and verify current runtime

**Files:**
- Deploy from: `plugin/mashirobot-plugin-game-timer/block/powershell/`
- Deploy to: `C:\ProgramData\MashiroBot\mashirobot-plugin-block\workers\`
- Verify state: `C:\ProgramData\MashiroBot\mashirobot-plugin-block\state.json`

**Interfaces:**
- Consumes: `install-block.ps1 -Mode Install -SqlitePath <planner.sqlite>`.
- Produces: updated SYSTEM tasks and a verified successful `LastSync` state.

- [ ] **Step 1: Run the complete focused test set**

Run:

```powershell
node --test plugin/mashirobot-plugin-game-timer/block/tests/*.test.mjs
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
```

Expected: zero failures.

- [ ] **Step 2: Install the updated worker elevated**

Run `install-block.ps1 -Mode Install` with `plan/sqlite/openclaw-planner.sqlite`, using PowerShell 7 with Administrator privileges. The installer copies the worker and re-registers the two SYSTEM tasks.

- [ ] **Step 3: Trigger an elevated reapply**

Run the deployed worker with `-Mode Reapply`, the production SQLite path, and `C:\ProgramData\MashiroBot\mashirobot-plugin-block` as `StateRoot`.

- [ ] **Step 4: Verify deployment and runtime state**

Confirm:

```text
LastSync.ok = true
ClashReloadPending = false
MashiroBot-mashirobot-plugin-block-Reapply = Ready
MashiroBot-mashirobot-plugin-block-Scan = Ready
```

Also verify the deployed worker hash equals the repository worker hash.

- [ ] **Step 5: Verify evening behavior through the plugin route**

Use a controlled test context at 19:00 Shanghai to request more than 30 minutes and assert the route accepts it and reports `晚上不限额`. Do not mutate the production release record for this test.

- [ ] **Step 6: Commit any deployment documentation adjustment only if required**

No commit is needed for runtime-only deployment. If installer documentation changed, commit only those tracked files with a scoped message.
