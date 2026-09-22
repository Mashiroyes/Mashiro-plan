# MashiroBot / Plan Architecture Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Incrementally modernize MashiroBot's process execution, startup lifecycle, plugin boundaries, routing states, reconciliation, clock, and diagnostics while preserving all current user behavior and historical data.

**Architecture:** Keep the existing adapter and plugin entry points stable while adding focused Core services and plugin-owned lifecycle registrations. SQLite remains desired state and Windows Task Scheduler remains its recoverable projection. Existing uncommitted work is the baseline and is preserved unless it conflicts with the approved design.

**Tech Stack:** Node.js ESM, Python, PowerShell 7, SQLite, Windows Task Scheduler, Node test runner, Python unittest, PowerShell integration tests.

**Spec:** `docs/superpowers/specs/2026-09-22-mashirobot-architecture-modernization-design.md`

## Global Constraints

- Local unmatched messages alone may fall through to GPT; matched failures must remain handled locally.
- Preserve `sqlite/openclaw-planner.sqlite`, WAL, foreign keys, busy timeout, all plan history, and forward-only migrations.
- Preserve `Asia/Shanghai` and the 06:00 sleep business-day boundary.
- Preserve reminder repetition, wake-up behavior, acknowledgement IDs, priority, silence, pause, merge, recovery, and idempotency.
- Preserve `job_id + version` validation before worker side effects.
- Keep machine-specific configuration in `%LOCALAPPDATA%\MashiroBot\config\machine.json`.
- Do not perform real music playback, volume changes, game termination, file deletion/movement, reminder mutation, or unnecessary WeChat delivery during tests.
- Per the user instruction for this run, do not run tests between implementation tasks. Perform static diff review during implementation and run all relevant tests once after all code and documentation changes are complete.

---

### Task 1: Consolidate the Existing Working-Tree Baseline

**Files:**
- Review: all currently modified and untracked files from `git status --short`
- Modify only when required by later tasks

**Interfaces:**
- Consumes: the other completed session's startup, health, routing, and Plan bridge changes
- Produces: a recorded baseline in the final report with no unrelated file rollback

- [ ] **Step 1: Capture the exact working-tree file list and diff statistics**

Run read-only `git status --short`, `git diff --stat`, and `git diff --check`.

- [ ] **Step 2: Classify every existing hunk**

Mark each hunk as compatible, superseded by this plan, or unrelated. Preserve compatible and unrelated hunks. Edit superseded hunks in place instead of reverting whole files.

- [ ] **Step 3: Confirm safety boundaries**

Verify no implementation command in later tasks writes to the formal SQLite database or installed Windows tasks before the final explicit deployment stage.

### Task 2: Complete ProcessRunner Metadata and Profiles

**Files:**
- Modify: `core/execution/local-process.mjs`
- Modify: `core/bridge/context.mjs`
- Modify: `tests/local-process.test.mjs`
- Modify: `tests/router-concurrency.test.mjs`

**Interfaces:**
- Consumes: existing `runLocalProcess(options)` and `LocalProcessError`
- Produces: `PROCESS_TIMEOUT_PROFILES`, `resolveProcessTimeout(profile, override)`, and normalized success/error metadata containing `ok`, `operation`, `operationId`, `requestId`, and `durationMs`

- [ ] **Step 1: Add named timeout profiles**

Export immutable defaults for `python`, `powershell`, `schtasks`, and `external`. Resolve an explicit `timeoutMs` before a named profile, and reject unknown profiles.

- [ ] **Step 2: Normalize metadata**

Accept optional `operation`, `requestId`, and `logger`. Include them in success results, typed errors, and completion callbacks. Preserve the existing `elapsedMs` field as a compatibility alias for `durationMs`.

- [ ] **Step 3: Emit structured process events**

Emit `process_start` before spawning and `process_complete` exactly once after success or failure. Include no command arguments or environment values in default log records.

- [ ] **Step 4: Propagate request metadata through plugin context**

Make `context.runLocalProcess()` inject the current request ID unless the caller already supplied one, preserve caller completion hooks, and retain external-duration metrics.

- [ ] **Step 5: Add deferred tests without running them**

Extend the existing process tests for timeout profiles, metadata propagation, log redaction, success, non-zero exit, timeout, cancellation, missing executable, bounded stdout/stderr, and exactly-once completion.

### Task 3: Remove Synchronous Child Processes from Message Paths

**Files:**
- Modify: `plugin/mashirobot-plugin-financial-report/index.mjs`
- Modify: `plugin/mashirobot-plugin-financial-report/core/handler.mjs`
- Modify: `plugin/mashirobot-plugin-financial-report/tests/handler.test.mjs`
- Modify: `plugin/mashirobot-plugin-financial-report/tests/plugin-shell.test.mjs`
- Review: `plugin/mashirobot-plugin-plan/bridge/planner-runner.mjs`

**Interfaces:**
- Consumes: `context.runLocalProcess(options)`
- Produces: asynchronous `wakeFeedbackTask(context)` and asynchronous financial-report `handle()`

- [ ] **Step 1: Replace message-path `spawnSync()`**

Use `context.runLocalProcess({ executable: "schtasks.exe", args: ["/Run", "/TN", "MashiroBot Financial Report Feedback"], timeoutProfile: "schtasks", operation: "financial-report-feedback-wake" })`.

- [ ] **Step 2: Await the wake path end to end**

Make the financial-report handler await command handling when the handler can wake the feedback task. Preserve all reply text and the injectable `wakeFinancialReportFeedbackTask` test seam.

- [ ] **Step 3: Validate the Plan bridge statically**

Ensure `planner-runner.mjs` uses the shared runner, passes a PowerShell profile, preserves JSON parsing and current user-facing timeout errors, and never uses a synchronous child-process API.

- [ ] **Step 4: Add deferred regression tests**

Cover successful wake, non-zero exit, timeout, and proof that handler completion awaits the scheduled-task invocation.

### Task 4: Introduce an Injectable Runtime and Thin Bootstrap

**Files:**
- Create: `core/runtime/mashirobot-runtime.mjs`
- Modify: `core/index.mjs`
- Create: `tests/runtime-lifecycle.test.mjs`
- Modify: `tests/router-concurrency.test.mjs`

**Interfaces:**
- Consumes: database startup, plugin loader, routers, managers, reconciler, logger, Clock, and ProcessRunner
- Produces: `createMashiroBotRuntime(options)` returning `{ handleMessage, diagnostics, getStatus, shutdown, registry }`

- [ ] **Step 1: Move startup composition into the runtime factory**

Resolve canonical paths, backup/migrate the database, create managers, load plugins, register lifecycle hooks, reconcile tasks, and build routers inside the factory. Allow every external dependency to be injected.

- [ ] **Step 2: Define readiness transitions**

Start at `booting`; database startup failure becomes `failed`; plugin or reconciliation failure becomes `degraded`; complete startup becomes `ready`.

- [ ] **Step 3: Add explicit shutdown**

Run registered shutdown hooks exactly once and reject no new messages solely because a nonessential cleanup hook failed. Record cleanup failures in diagnostics.

- [ ] **Step 4: Reduce `core/index.mjs` to production composition**

Create one lazy runtime promise, preserve `handleMashiroBotMessage()`, `getMashiroBotStartupStatus()`, and `pluginRegistry`, and keep startup failures local with `handled: true`.

- [ ] **Step 5: Add deferred lifecycle tests**

Cover one startup shared by concurrent requests, dependency injection, ready/degraded/failed transitions, startup failure not falling through, and idempotent shutdown.

### Task 5: Enforce Plugin Contract and Explicit Route States

**Files:**
- Modify: `core/contracts/plugin-result.mjs`
- Modify: `core/router/plugin-router.mjs`
- Modify: `core/loader/plugin-loader.mjs`
- Modify: `docs/plugin-contract.md`
- Modify: `tests/plugin-router.test.mjs`
- Modify: `tests/plugin-loader.test.mjs`

**Interfaces:**
- Produces: `ROUTE_STATES`, `notMatched()`, `matchedSuccess(result)`, and `matchedFailure(errorResult)` internal results
- Preserves: the adapter-facing handled result shape

- [ ] **Step 1: Add the internal route-state constructors**

Represent `NOT_MATCHED`, `MATCHED_SUCCESS`, and `MATCHED_FAILED` explicitly. Validate that matched results contain the existing reply/media contract.

- [ ] **Step 2: Enforce synchronous `match()`**

Call `match()` without `await`. If it returns a thenable, produce a local `MATCHED_FAILED` contract error attributed to that plugin; never continue to another plugin or GPT.

- [ ] **Step 3: Bound asynchronous handler execution**

Await synchronous or asynchronous `handle()` through one timeout helper. Convert throw, reject, timeout, and invalid result into `MATCHED_FAILED`.

- [ ] **Step 4: Translate states at the compatibility boundary**

Return `null` only for `NOT_MATCHED`. Return the normalized existing `handled: true` object for both matched states.

- [ ] **Step 5: Update contract validation and documentation**

Document that `match()` is synchronous/pure, `handle()` and `healthCheck()` may be asynchronous, and matched failure is terminal locally.

- [ ] **Step 6: Add deferred tests**

Cover unmatched, sync match, Promise-returning match, synchronous handler, asynchronous handler, throw, reject, timeout, invalid result, exact-command ordering, and no GPT fallback after match.

### Task 6: Move Undo and Acknowledgement Business Logic to Plugins

**Files:**
- Modify: `core/control/undo-manager.mjs`
- Create: `core/control/lifecycle-hooks.mjs`
- Modify: `core/control/system-command-router.mjs`
- Modify: `core/runtime/mashirobot-runtime.mjs`
- Modify: `plugin/mashirobot-plugin-plan/index.mjs`
- Create: `plugin/mashirobot-plugin-plan/lifecycle.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/index.mjs`
- Create: `plugin/mashirobot-plugin-game-timer/lifecycle.mjs`
- Modify: `tests/safety-undo-diagnostics.test.mjs`
- Create: `tests/lifecycle-hooks.test.mjs`

**Interfaces:**
- Produces: `createLifecycleHooks()` with duplicate-safe `registerUndo`, `registerAcknowledgement`, `runAcknowledgement`, and `shutdown`
- Consumes: plugin optional `registerLifecycle(context)` export

- [ ] **Step 1: Add a small lifecycle registry**

Reject duplicate undo keys and duplicate acknowledgement keys at startup. Run handlers by owner/kind without exposing other plugins' table names to Core.

- [ ] **Step 2: Make UndoManager registrations dynamic**

Add `register(kind, handler)` and keep constructor-provided handlers compatible. Reject accidental replacement.

- [ ] **Step 3: Move Plan-owned handlers**

Move general-reminder acknowledgement, plan-version restoration, and English-keyword reversal out of `core/index.mjs` into the Plan plugin lifecycle module while preserving paths, SQL predicates, timeouts, environment, and replies.

- [ ] **Step 4: Move game-timer undo**

Move `game_timer_tasks` cancellation and scheduled-task deletion to the game-timer lifecycle module.

- [ ] **Step 5: Register optional plugin lifecycle hooks during startup**

Invoke registration only after module validation and before routing becomes ready. A registration failure degrades that plugin and is visible in diagnostics.

- [ ] **Step 6: Add deferred tests**

Cover duplicate registration, correct owner dispatch, cleanup-pending behavior, handler failure recovery, and absence of Plan/game table or script names from Core runtime files.

### Task 7: Add a Shared Clock and Preserve Time Semantics

**Files:**
- Create: `core/time/clock.mjs`
- Modify: `core/bridge/context.mjs`
- Modify: `core/control/reminder-manager.mjs`
- Modify: `core/control/job-manager.mjs`
- Modify: affected Plan sleep/date modules only where they duplicate these calculations
- Create: `tests/clock.test.mjs`

**Interfaces:**
- Produces: `createClock({ now })` with `utcNow()`, `shanghaiNow()`, `shanghaiDate()`, and `sleepBusinessDate()`

- [ ] **Step 1: Implement immutable Clock values**

Use `Intl.DateTimeFormat` with `Asia/Shanghai`; calculate the sleep business date by shifting the instant six hours before deriving the Shanghai date.

- [ ] **Step 2: Inject Clock into request context and shared managers**

Retain `context.now`, `context.localDate`, and existing manager `now` options for compatibility while routing calculations through Clock.

- [ ] **Step 3: Avoid broad business-code rewrites**

Change only duplicated date calculations directly involved in startup, reminders, jobs, or sleep records. Do not alter unrelated display formatting.

- [ ] **Step 4: Add deferred boundary tests**

Cover Shanghai 05:59:59 and 06:00:00, midnight, month end, year end, and equivalent UTC instants.

### Task 8: Harden Reconciliation and Deployment Diagnostics

**Files:**
- Modify: `core/control/windows-task-reconciler.mjs`
- Modify: `core/control/windows/job-reconcile.ps1`
- Modify: `core/control/system-diagnostics.mjs`
- Create: `core/health/deployment-identity.mjs`
- Modify: `core/runtime/mashirobot-runtime.mjs`
- Create: `tests/windows-task-reconciler.test.mjs`
- Create: `tests/deployment-identity.test.mjs`

**Interfaces:**
- Produces: deterministic reconcile summary `{ ok, missing, drifted, orphaned, applied, failed }`
- Produces: deployment identity with source/runtime/database/config paths, start time, and optional Git/build IDs

- [ ] **Step 1: Make reconciliation actions deterministic**

Sort desired and observed tasks, compare executable/arguments/version, and avoid applying changes to already matching tasks.

- [ ] **Step 2: Preserve failed desired state**

Report create/update/delete failures without changing a logical job to a falsely completed state. A repeated run retries only remaining drift.

- [ ] **Step 3: Keep self-check read only**

Ensure `apply: false` and `自检` never create, update, or delete Windows tasks.

- [ ] **Step 4: Add deployment identity**

Resolve source root, runtime root, canonical database, machine config, start time, and optional Git/build IDs. Missing Git metadata becomes `unknown`.

- [ ] **Step 5: Add deferred tests**

Cover missing task, orphan, version/action drift, create/delete failure, repeat-run no-op, dry-run safety, and unavailable Git metadata.

### Task 9: Complete Health, State-Machine, and README Documentation

**Files:**
- Modify: `README.md`
- Modify: affected `plugin/*/README.md`
- Modify: `docs/plugin-contract.md`
- Create: `docs/state-machines.md`
- Modify: `docs/migration-report.md` only if a migration is added
- Modify: `tests/readme-boundary.test.mjs`
- Modify: `tests/health-contract.test.mjs`

**Interfaces:**
- Documents the final public and internal contracts implemented by Tasks 2-8

- [ ] **Step 1: Document runtime and route behavior**

Describe bootstrap, readiness states, matched-failure terminal behavior, ProcessRunner, request IDs, and plugin lifecycle registration.

- [ ] **Step 2: Document state machines**

Record allowed transitions, retry behavior, version increments, catch-up rules, and completion criteria for reminders, jobs, plan reminders, wake-up reminders, and game timers.

- [ ] **Step 3: Update affected plugin READMEs**

Document only plugin-owned behavior and tests; keep shared mechanisms in the root README and plugin contract.

- [ ] **Step 4: Add deferred documentation tests**

Assert the public invariants and required documentation links without duplicating implementation details.

### Task 10: Unified Final Verification and Safe Deployment Decision

**Files:**
- Inspect: all changed files
- Do not modify production SQLite or Windows tasks unless every prior verification passes

**Interfaces:**
- Produces: final evidence report and, only if safe, synchronized runtime deployment

- [ ] **Step 1: Run static checks**

Run `git diff --check`, inspect `git diff --stat`, search production message paths for direct `spawnSync`, and search Core runtime files for plugin-owned table/script names.

- [ ] **Step 2: Run the complete root Node suite once**

Run `node --test tests/*.test.mjs` from `plan` and record pass/fail/skip counts.

- [ ] **Step 3: Run every affected plugin's documented Node tests once**

Run the Plan, game-timer, financial-report, language, status, and loot suites whose shared contracts or runtime context changed.

- [ ] **Step 4: Run affected Python tests once**

Run the Plan planner, runtime-state, chart, English-skills, and help-renderer tests listed in the affected READMEs.

- [ ] **Step 5: Run safe PowerShell tests once**

Run machine-config, path-policy, adapter-repair, task-path, system-Python-policy, and affected plugin worker tests only in their dry-run or isolated fixture modes.

- [ ] **Step 6: Validate formal database safety read only**

Run integrity inspection, confirm the canonical database path, verify expected historical tables and nonzero historical row counts where applicable, and verify no migration was applied unless explicitly required by the implementation.

- [ ] **Step 7: Inspect reconciliation without applying**

Run the reconciler with `apply: false`; record missing, drifted, orphaned, and failed counts. Do not repair automatically if an action could delete an unexpected task.

- [ ] **Step 8: Review the entire diff**

Check that no unrelated change was reverted, no machine path or credential entered Git, user-visible replies remain compatible, and documentation matches code.

- [ ] **Step 9: Decide deployment from evidence**

If all tests and safety checks pass, synchronize only the known runtime copies through the existing installer/deployment mechanism and verify deployment identity. If any verification fails, leave source changes intact, do not deploy, and report the exact blocker.

- [ ] **Step 10: Produce the phase-complete report**

Report modifications, reasons, files, user-visible behavior, database migrations, Windows Task impact, commands run, results, and remaining risks.
