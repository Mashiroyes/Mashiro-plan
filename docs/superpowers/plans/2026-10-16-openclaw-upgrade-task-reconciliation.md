# OpenClaw Upgrade Task Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore all MashiroBot local commands after the OpenClaw upgrade and eliminate false degraded startup caused by legacy and mismatched Windows task projections.

**Architecture:** Keep `managed_jobs` as the desired-state source, but normalize its lifecycle and execution metadata before comparing it with Task Scheduler. PowerShell remains responsible for Windows projection, while Node owns job-state transitions and testable time logic.

**Tech Stack:** Node.js ESM, better-sqlite3, PowerShell 7, Windows Task Scheduler, OpenClaw 2026.10.3, Tencent Weixin plugin 2.4.10.

## Global Constraints

- Preserve the existing SQLite history and create a backup before live data repair.
- Do not modify QQ, FocusLock, or unrelated dirty worktree files.
- Use explicit PowerShell 7, Node, and pinned MashiroBot Python paths in deployment checks.
- Completion requires both local route coverage and real Weixin inbound/outbound evidence.

---

### Task 1: Expire stale one-shot managed jobs

**Files:**
- Modify: `core/control/job-manager.mjs`
- Modify: `core/control/job-cli.mjs`
- Test: `tests/control-plane.test.mjs`

**Interfaces:**
- Consumes: `createJobManager({ sqlitePath, now? })` and the `managed_jobs` table.
- Produces: `expirePastOneShot({ before? }): number`; CLI action `expire-past-one-shot` returning `{ expired }`.

- [ ] **Step 1: Write failing manager tests**

Add tests with a fixed clock proving that a non-recurring `desired` job before the cutoff becomes `failed` with `error='expired before task reconciliation'`, while recurring, future, completed, and cancelled jobs remain unchanged.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/control-plane.test.mjs`

Expected: FAIL because `expirePastOneShot` does not exist.

- [ ] **Step 3: Implement the manager transition**

Add an atomic update equivalent to:

```js
expirePastOneShot({ before = now() } = {}) {
  const at = new Date(before).toISOString();
  return withDb((db) => db.prepare(`
    UPDATE managed_jobs
    SET status='failed', completed_at=?, error='expired before task reconciliation', updated_at=?
    WHERE status IN ('desired','running')
      AND recurrence_json IS NULL
      AND run_at IS NOT NULL
      AND run_at < ?
  `).run(at, at, at).changes);
}
```

Use the manager's injected clock for the default cutoff.

- [ ] **Step 4: Add the CLI action**

Map `expire-past-one-shot` to `manager.expirePastOneShot(payload)` and emit `{ expired }`.

- [ ] **Step 5: Run focused tests**

Run: `node --test tests/control-plane.test.mjs`

Expected: PASS.

---

### Task 2: Make PowerShell reconciliation backward compatible

**Files:**
- Modify: `core/control/windows/job-reconcile.ps1`
- Create: `tests/test-job-reconcile.ps1`

**Interfaces:**
- Consumes: JSON jobs emitted by `job-cli.mjs list`, where `payload.reconcile` is optional.
- Produces: the existing last-line JSON reconciliation report without StrictMode property failures.

- [ ] **Step 1: Add a focused fixture test**

Create a temporary copied SQLite database containing one future desired job whose payload has only `execution`. Stub Task Scheduler cmdlets within the test process so Apply reaches the generic registration branch without touching the real scheduler. Assert `failed.Count -eq 0` and that the expected task name is recreated.

- [ ] **Step 2: Run the test and verify failure**

Run: `pwsh -NoProfile -NonInteractive -File tests/test-job-reconcile.ps1`

Expected: FAIL with the missing `reconcile` property under StrictMode.

- [ ] **Step 3: Guard the optional property**

Replace direct access with an explicit property check:

```powershell
$reconcileProperty = $job.payload.PSObject.Properties['reconcile']
if ($null -ne $reconcileProperty -and $null -ne $reconcileProperty.Value) {
    $reconcile = $reconcileProperty.Value
    $invokeArgs = @($reconcile.argumentList | ForEach-Object { [string]$_ })
    & ([string]$reconcile.executable) @invokeArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Reconcile installer failed with exit code $LASTEXITCODE" }
    $recreated += $job.taskName
    continue
}
```

- [ ] **Step 4: Expire old one-shot jobs before listing desired state**

In Apply mode, call the new CLI action after `recover-stale` and before `list`; expose the count as `expiredPastOneShot` in the JSON report.

- [ ] **Step 5: Run the PowerShell and Node tests**

Run:

```powershell
pwsh -NoProfile -NonInteractive -File tests/test-job-reconcile.ps1
node --test tests/control-plane.test.mjs tests/runtime-lifecycle.test.mjs
```

Expected: all PASS.

---

### Task 3: Record the English task's actual hidden action

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1`
- Modify: `plugin/mashirobot-plugin-plan/tests/test_english_skills_windows.ps1`

**Interfaces:**
- Consumes: `$wscript`, `$launcher`, and the already-built `$arguments` string used by `New-ScheduledTaskAction`.
- Produces: `payload.execution = @{ executable=$wscript; arguments=$arguments }`, exactly matching Task Scheduler.

- [ ] **Step 1: Add a failing installer contract assertion**

Extend the existing fixture to inspect the upsert payload and assert that `execution.executable` ends with `wscript.exe`, `execution.arguments` contains `run-hidden-worker.vbs`, and the registered action equals the payload action.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-plan/tests/test_english_skills_windows.ps1`

Expected: FAIL because the payload currently records direct `pwsh.exe` execution.

- [ ] **Step 3: Change the upsert payload**

Use the same values as registration:

```powershell
payload = @{
    execution = @{ executable = $wscript; arguments = $arguments }
    reconcile = $reconcile
}
```

Remove `$workerArguments` if no longer used.

- [ ] **Step 4: Run the focused test**

Run: `pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-plan/tests/test_english_skills_windows.ps1`

Expected: PASS.

---

### Task 4: Repair live desired state without rebuilding healthy tasks

**Files:**
- Data: `sqlite/openclaw-planner.sqlite`
- Backup: `sqlite/backups/control/`

**Interfaces:**
- Consumes: current Task Scheduler actions for all four English statistics tasks.
- Produces: desired jobs whose `payload.execution` matches those verified actions and an expired stale one-shot job outside desired state.

- [ ] **Step 1: Create and verify a database backup**

Copy the database plus WAL/SHM consistently using the existing backup helper, then run `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the backup.

- [ ] **Step 2: Re-read all four actual English task actions**

Abort if any task is missing or does not use `wscript.exe`, `run-hidden-worker.vbs`, and `runtime-v1`.

- [ ] **Step 3: Update desired state through supported APIs**

Upsert each English statistics job with its existing owner, kind, recurrence, reconcile payload, and actual action. Invoke `expire-past-one-shot` once; do not directly delete rows.

- [ ] **Step 4: Run reconciliation Inspect**

Run: `pwsh -NoProfile -NonInteractive -File core/control/windows/job-reconcile.ps1 -Mode Inspect -SqlitePath sqlite/openclaw-planner.sqlite`

Expected: `missing=[]`, `drifted=[]`, `orphaned=[]`, `failed=[]`.

- [ ] **Step 5: Verify live database integrity**

Expected: `integrity_check=ok`, `foreign_key_check=[]`.

---

### Task 5: Regression and runtime acceptance

**Files:**
- Verify only; no planned source edits.

**Interfaces:**
- Consumes: repaired source, live database, installed Weixin 2.4.10 adapter, and OpenClaw gateway task.
- Produces: current runtime evidence for completion.

- [ ] **Step 1: Run focused regression suites**

Run relevant core, plan, language, status, and adapter tests. Expected: zero failures.

- [ ] **Step 2: Restart the gateway through the registered task**

Verify the old listener PID exits, a new listener owns `127.0.0.1:18789`, and `openclaw gateway health --timeout 30000` reports OK with Weixin configured.

- [ ] **Step 3: Verify startup state**

Trigger one MashiroBot route and inspect the new log segment. Expected: five plugins loaded and `startup_completed` reports `state=ready` with no `job_reconcile_failed`.

- [ ] **Step 4: Verify local command classes**

Run non-destructive route checks for `help`, `查询今日计划`, a temporary test reminder that is immediately cancelled, and `状态`. Expected: no `PROCESS_EXIT_NONZERO` and valid text/media outputs.

- [ ] **Step 5: Verify Weixin end to end**

Through the actual Weixin conversation, send commands covering help, Python query, PowerShell reminder, and status image. Confirm the gateway log contains `MashiroBot local route handled` for each and outbound delivery success, with no `The local process exited unsuccessfully` response.

