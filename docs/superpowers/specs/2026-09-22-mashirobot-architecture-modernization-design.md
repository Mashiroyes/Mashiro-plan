# MashiroBot / Plan Architecture Modernization Design

## Purpose

Modernize the existing Windows-local MashiroBot / Plan system incrementally without replacing its Node.js, Python, PowerShell, SQLite, Windows Task Scheduler, or OpenClaw foundations. Reliability, data safety, behavior compatibility, and recovery take priority over architectural elegance.

This design treats the current working tree as the implementation baseline. Compatible uncommitted work is preserved; conflicting implementation is corrected in favor of this design. No database or task-scheduler mutation is performed merely to complete the refactor.

## Non-negotiable compatibility rules

- A message unmatched by every local plugin may fall through to GPT.
- Once a local plugin matches, success and failure both remain local. A failure must never be represented as an unmatched message.
- `sqlite/openclaw-planner.sqlite` remains the canonical database and all historical plan, completion, reminder, and job data is preserved.
- Database changes use forward-only versioned migrations. Before migration, the system checkpoints WAL, runs an integrity check, and creates a rotating backup.
- Business time remains `Asia/Shanghai`. Sleep records retain the 06:00 business-day boundary.
- Reminder repetition, wake-up behavior, short acknowledgement IDs, priority, silence, pause, merge, recovery, and idempotency remain compatible.
- SQLite is logical desired state. Windows Task Scheduler is an execution projection, and workers validate `job_id + version` before side effects.
- Machine-specific paths and recipients remain in `%LOCALAPPDATA%\MashiroBot\config\machine.json` rather than Git.
- Tests never perform real music playback, volume changes, game termination, destructive file operations, reminder mutation, or unnecessary WeChat delivery.

## Current-state findings

### P0: request-path blocking

The repository already has `core/execution/local-process.mjs`, which provides asynchronous spawning, timeout, cancellation, bounded output, and Windows process-tree termination. However, the financial-report plugin still invokes `spawnSync()` from a message path. A stalled `schtasks.exe` call can block the Node.js event loop and therefore unrelated messages.

### P1: runtime and ownership boundaries

`core/index.mjs` has a one-time startup promise, but importing the module still initiates backup, migration, plugin loading, and reconciliation. The startup composition cannot be constructed with test doubles or shut down explicitly.

Core also owns plugin-specific undo and acknowledgement behavior: it updates `general_reminders` and `game_timer_tasks`, invokes the plan Python command, and runs `manage-plan.ps1`. These responsibilities prevent plugins from owning their business data and cleanup rules.

The router awaits `match()`, which silently permits asynchronous matching despite the intended fast, synchronous, side-effect-free contract. Plugin handlers can be asynchronous, but no common handler timeout prevents a never-settling plugin from occupying a request indefinitely.

### P2: incomplete result and observability models

The external-process layer does not yet standardize operation names, request IDs, per-command timeout classes, or structured start/completion logging. The router ultimately distinguishes local handling only through a nullable result and `handled`, rather than an explicit internal three-state result.

Time creation remains distributed. Deployment identity and readiness information are not exposed as one structured diagnostics model.

### P3: deferred improvements

Plugin capabilities, broader PowerShell module extraction, and repository-wide database-service consolidation are useful but are not prerequisites for removing the immediate reliability risks. They remain optional follow-up work unless later phases demonstrate a concrete need.

## Alternatives considered

### Recommended: compatibility-first staged modernization

Keep the existing public adapter and plugin entry points, introduce narrow internal interfaces, and migrate one execution path at a time. Each phase leaves the system runnable and independently testable. This approach has the smallest data and behavior risk.

### Rebuild the core around a new framework

A new dependency-injection framework or TypeScript rewrite could make boundaries explicit, but it would expand the regression surface across every plugin and worker. It is rejected for this project.

### Patch only the original PowerShell timeout

Replacing one `spawnSync()` call would address a symptom but leave other blocking calls, lifecycle coupling, and ambiguous routing semantics intact. It is too narrow for the requested outcome.

## Target architecture

```text
OpenClaw adapter
  -> MashiroBot Runtime
       -> Command Router
       -> Plugin Router
       -> Clock
       -> Process Runner
       -> Reminder / Job shared mechanisms
       -> Lifecycle hooks and diagnostics
  -> Plugins own business parsing, storage rules, undo, and acknowledgement
  -> SQLite stores desired logical state
  -> Reconciler projects desired state into Windows Task Scheduler
```

The OpenClaw adapter remains thin. Core owns reusable mechanisms. Plugins own their domain-specific tables, scripts, and reversal/cleanup behavior.

## Phase 1: unified ProcessRunner

Evolve `core/execution/local-process.mjs` rather than replacing it.

The runner accepts:

- `executable`, `args`, `cwd`, `env`, and `signal`
- `timeoutMs` or a named timeout profile
- `maxStdoutBytes` and `maxStderrBytes`
- `operation`, `operationId`, and `requestId`
- an injected logger and process-spawn implementation for tests

Success returns a normalized record containing `ok`, `exitCode`, `stdout`, `stderr`, `durationMs`, `operation`, and identifiers. Failures continue to use one typed error with the same captured fields so callers can distinguish timeout, cancellation, output overflow, spawn failure, non-zero exit, and invalid output.

On Windows, timeout, cancellation, and overflow terminate the whole process tree through `taskkill.exe /PID <pid> /T /F`. Failure to clean up is logged but does not replace the original failure reason.

Named profiles provide explicit defaults for ordinary Python, PowerShell, `schtasks.exe`, and other external programs. Call sites can override them when an established operation genuinely needs longer.

Migration begins with request-path calls, especially financial-report feedback scheduling and the Plan bridge. Worker-only synchronous calls are migrated afterward when doing so does not disrupt their isolated process model.

## Phase 2: Runtime and bootstrap

Introduce `createMashiroBotRuntime(options = {})` in a focused runtime module. It resolves canonical paths, performs protected database startup, constructs shared services, loads plugins, runs initial reconciliation, and returns:

```js
{
  handleMessage,
  diagnostics,
  getStatus,
  shutdown
}
```

Dependencies such as process execution, logging, clock, plugin loading, database paths, and reconciliation are injectable. Production `core/index.mjs` becomes a small composition entry point that lazily creates one runtime and preserves the existing exported message handler.

Startup state is `booting`, `ready`, `degraded`, or `failed`:

- database integrity or migration failure: `failed`, not ready, handled locally
- nonessential plugin load failure: `degraded`
- reconciliation failure: `degraded`
- all required startup checks complete: `ready`

Reconciliation failure does not prevent unrelated local features from starting. Database startup failure never falls through to GPT.

## Phase 3: plugin contract and routing states

`match(text, context)` remains synchronous, fast, and side-effect free. Returning a Promise is a contract violation reported as a local plugin error; it is not awaited.

`handle(text, context)` and `healthCheck(context)` may return either a value or a Promise. The router awaits them through a common invocation boundary with a configurable timeout and normalized error mapping.

Internally the router uses three states:

- `NOT_MATCHED`
- `MATCHED_SUCCESS`
- `MATCHED_FAILED`

The adapter translates only `NOT_MATCHED` into `handled: false`. Both matched states translate to `handled: true`. Existing reply and media fields remain compatible.

Exact commands still route before natural-language matching, and plugin priority remains unchanged.

## Phase 4: Core / Plugin decoupling

Core provides lifecycle registries rather than knowing plugin table names or scripts:

- `UndoManager.register(kind, handler)`
- acknowledgement hooks keyed by plugin and reminder kind
- optional startup and shutdown hooks

Plugins register handlers during runtime composition or plugin initialization. The Plan plugin owns general-reminder acknowledgement and plan-version restoration. The game-timer plugin owns game cancellation. The language or Plan owner of English-keyword management registers that undo behavior explicitly.

Registration is intentionally small and does not introduce a dependency-injection framework. Duplicate registrations fail at startup with a diagnostic rather than silently replacing one another.

## Phase 5: desired state, reconciliation, and idempotency

The existing `managed_jobs` model and `job_id + version` worker claims remain the foundation. Reconciliation compares SQLite desired jobs with observed Windows tasks and produces deterministic actions. A second reconciliation against unchanged state must produce no additional mutations.

Cancellation records desired cancellation before task deletion. Task deletion failure leaves a retryable reconciliation condition rather than pretending that the operation completed. Existing domain tables are changed only when a concrete incompatibility requires it; any schema extension is a new versioned migration.

Logical reminders and delivery attempts are separated only where repeated delivery currently lacks a durable identity. If needed, a forward-only migration adds a delivery key without rewriting historical reminders.

Reconciliation runs at startup, after task-projection failures, during explicit self-check in dry-run mode, and through the existing low-frequency recovery mechanism. Resume-from-sleep integration is added only through an existing safe trigger or a separately tested hook.

## Phase 6: Clock, request tracing, health, and deployment identity

A shared Clock exposes UTC now, Shanghai now, Shanghai calendar date, and the 06:00 sleep business date. Production uses the system clock; tests inject fixed instants covering 05:59:59, 06:00:00, midnight, month end, and year end.

Every inbound message receives one `requestId`. Process calls receive an `operationId`; both identifiers flow through structured logs and operation journal records where applicable.

Diagnostics report:

- liveness and readiness state
- plugin health with `ok`, `degraded`, or `failed`
- source root, runtime root, database path, machine-config path, start time, and available build or Git identity
- reconciliation differences without mutation during `自检`

Unavailable Git metadata degrades only that diagnostic field and never blocks startup.

## Error handling

All errors are classified at the narrowest boundary that understands them. ProcessRunner preserves executable evidence without leaking sensitive environment values. Plugin invocation converts exceptions, rejections, timeouts, and contract violations into `MATCHED_FAILED`. The adapter never converts a matched failure into an unmatched result.

Logs contain timestamp, level, plugin ID, event, message, request ID, operation, and duration when available. Payloads, credentials, message recipients, and full environment values are not logged.

## Data and Windows Task safety

The first four phases require no database migration. They change orchestration and ownership, not stored history.

Before any later schema migration, the implementation must:

1. resolve the canonical database path once;
2. checkpoint WAL;
3. run `PRAGMA integrity_check`;
4. create and verify a rotating backup;
5. apply only unapplied checksum-verified migrations;
6. run post-migration integrity checks.

Tests use temporary databases and fake process/task implementations. Production task names, installed tasks, formal reminders, media playback, process termination, and file operations are not mutated by automated tests.

## Testing strategy

Each implementation phase adds focused regression tests, followed by the complete relevant suite at the phase boundary. Coverage includes:

- unmatched, matched-success, and matched-failure routing
- synchronous match enforcement
- synchronous and asynchronous handlers, rejection, throw, and timeout
- process success, non-zero exit, timeout, cancellation, missing executable, stderr, large output, and Windows tree termination
- one startup barrier shared by concurrent requests
- ready, degraded, and failed startup states
- plugin-owned undo and acknowledgement registration
- matching and stale `job_id + version`
- reconciliation create, delete, stale version, failure, and second-run no-op
- Shanghai and sleep-boundary clock behavior
- unchanged formal SQLite data and integrity

Required verification includes the root Node suite, each affected plugin's documented Node/Python/PowerShell tests, static checks for direct child-process use in request paths, database integrity checks, and dry-run reconciliation. Real user-facing side effects remain disabled.

## Documentation and rollout

Every phase updates the root README, affected plugin README files, `docs/plugin-contract.md`, and migration or state-machine documentation when its behavior changes. `docs/state-machines.md` documents reminder, managed-job, plan-reminder, wake-up, and game-timer transitions.

Source changes are verified before deployment. Runtime-copy synchronization is a separate explicit step, followed by deployed-path diagnostics. Failure to obtain a Git commit or runtime version is reported as unknown rather than treated as startup failure.

Each phase report states what changed, why, files changed, user-visible behavior, database migration status, Windows Task impact, tests run, results, and remaining risks.

## Delivery sequence

1. Preserve and validate the current compatible working-tree changes.
2. Complete ProcessRunner and remove request-path blocking calls.
3. Introduce the injectable Runtime and thin bootstrap.
4. Enforce the plugin async boundary and explicit route states.
5. Move undo and acknowledgement behavior into owning plugins.
6. Harden desired-state reconciliation and idempotency only where evidence shows gaps.
7. Add Clock, deployment identity, structured health, and tracing.
8. Complete state-machine documentation, full regression testing, database integrity validation, and safe runtime deployment verification.

This order deliberately avoids simultaneous rewrites of routing, storage, workers, and documentation.
