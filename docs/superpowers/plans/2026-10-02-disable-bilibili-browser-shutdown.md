# Disable Bilibili Browser Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Bilibili blocking at release expiry without terminating browsers.

**Architecture:** Remove the expiry-specific process termination unit from the PowerShell worker while retaining the existing layered network/policy synchronization. Replace termination-oriented tests with an expired-release dry-run assertion that the normal blocking layers succeed and no browser shutdown layer exists.

**Tech Stack:** PowerShell 7, Node.js, node:sqlite, Windows Task Scheduler

## Global Constraints

- Do not alter release quotas or expiry times.
- Do not weaken hosts, browser-policy, or Clash restoration.
- Do not terminate a real browser during testing.

---

### Task 1: Remove browser termination behavior

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/block/tests/worker-fixture.mjs`

**Interfaces:**
- Consumes: `expiryResult.expiredReleases` through the existing expiry prompt path.
- Produces: A successful `Reapply`/`Scan` result containing normal blocking layers and no `bilibiliExpiryBrowserShutdown` layer.

- [ ] **Step 1:** Change the worker test to reject any `Stop-BilibiliBrowsersAfterExpiry` function or `bilibiliExpiryBrowserShutdown` layer.
- [ ] **Step 2:** Run `test-worker.ps1` and verify the new assertion fails against the current worker.
- [ ] **Step 3:** Delete `Stop-BilibiliBrowsersAfterExpiry` and its `Invoke-Layer` call; retain `Submit-BilibiliTimeoutPrompts`.
- [ ] **Step 4:** Run `test-worker.ps1` and all block Node tests; expect all tests to pass.

### Task 2: Deploy and verify the runtime copy

**Files:**
- Deploy source: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`
- Runtime copy: `C:\ProgramData\MashiroBot\mashirobot-plugin-block\workers\block-worker-v2.ps1`

**Interfaces:**
- Consumes: `install-block.ps1 -Mode Install` with the production SQLite and runtime descriptor.
- Produces: Two ready scheduled tasks referencing the deployed worker and a successful `LastSync` report.

- [ ] **Step 1:** Run the installer elevated using the production database and runtime descriptor.
- [ ] **Step 2:** Compare SHA-256 hashes of source and deployed worker; expect equality.
- [ ] **Step 3:** Trigger the Scan scheduled task and wait for completion; expect exit result `0`.
- [ ] **Step 4:** Inspect `state.json`; expect `LastSync.ok=true` and no `bilibiliExpiryBrowserShutdown` layer.
