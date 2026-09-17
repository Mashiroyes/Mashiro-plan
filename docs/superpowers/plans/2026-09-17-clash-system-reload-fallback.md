# Clash SYSTEM Reload Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the SYSTEM block worker apply Clash configuration changes through an authenticated loopback controller when the user-session named pipe is inaccessible.

**Architecture:** Add an HTTP transport beside the existing named-pipe transport. Retry both transports within a 12-second budget, preserving fail-closed success semantics and concrete diagnostics.

**Tech Stack:** PowerShell 7, .NET `HttpClient`, Windows named pipes, Clash Verge Rev/Mihomo, Windows Task Scheduler.

## Global Constraints

- Keep the controller bound only to `127.0.0.1:9097` with bearer authentication.
- Do not alter block-list contents, release durations, QQ controls, hosts rules, or browser policies.
- Report success only for HTTP 200 or 204.
- Keep the worker within the JavaScript syncer's 15-second verification window.

---

### Task 1: Add the authenticated loopback reload transport

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`

**Interfaces:**
- Consumes: generated Clash configuration path and bearer secret.
- Produces: `Invoke-ClashHttpReload` and `Invoke-ClashReload`, returning an object with `Ok` and `Error` properties.

- [x] **Step 1: Add assertions for loopback-only HTTP fallback and proxy bypass.**
- [x] **Step 2: Run `pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1` and require the new assertions to fail.**
- [x] **Step 3: Implement `HttpClient` PUT to `http://127.0.0.1:9097/configs?force=true` with `UseProxy=false`, bearer authentication, bounded timeout, and 200/204 validation.**
- [x] **Step 4: Retry HTTP and named-pipe transports within the existing 12-second budget and preserve both transport errors.**
- [x] **Step 5: Run the focused worker test and `node --test plugin/mashirobot-plugin-game-timer/block/tests/*.test.mjs`; require all tests to pass.**

### Task 2: Enable, deploy, and verify the running path

**Files:**
- Modify local setting: `C:\Users\Mashiroyes\AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev\verge.yaml`
- Modify generated runtime configurations: `clash-verge.yaml`, `clash-verge-check.yaml`
- Update installed worker: `C:\ProgramData\MashiroBot\mashirobot-plugin-block\workers\block-worker-v2.ps1`

**Interfaces:**
- Consumes: the tested worker from Task 1 and scheduled task `MashiroBot-mashirobot-plugin-block-Reapply`.
- Produces: loopback controller reachability and a verified SYSTEM reload.

- [x] **Step 1: Set `enable_external_controller: true` and bind generated controller entries to `127.0.0.1:9097`.**
- [x] **Step 2: Apply the current generated configuration through the user-accessible pipe and verify authenticated `/version` on port 9097.**
- [x] **Step 3: Deploy the source worker to the installed worker path using elevation and verify hashes match.**
- [x] **Step 4: Trigger SYSTEM reapply with pending reload state; require fresh success, task result 0, and pending false.**
- [x] **Step 5: Verify Bilibili release/access, QQ retention, and loopback-only listening.**
- [x] **Step 6: Commit and push the tested source changes to `Mashiroyes/Mashiro-plan` main.**
