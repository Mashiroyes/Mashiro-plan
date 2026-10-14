# Plan Bot New-Computer Deployment Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing new-computer installer into a repeatable, resumable deployment flow that proves Plan Bot works through the real OpenClaw/WeChat route and reports each control layer separately.

**Architecture:** Keep `%LOCALAPPDATA%\MashiroBot\config\machine.json` as the machine-specific source of truth, but add a generated runtime descriptor containing absolute executable paths and a per-run deployment report under `%LOCALAPPDATA%\MashiroBot\deployments`. A phase-based installer consumes that descriptor, patches only recognized OpenClaw layouts, installs scheduled tasks with explicit runtime arguments, and then runs local, identity-specific, and human-confirmed acceptance checks without treating partial success as full success.

**Tech Stack:** PowerShell 7.6+, Node.js 22+ (`node:test`, `node:sqlite`), Python 3.11-3.13 with Pillow, Windows Task Scheduler, SQLite, OpenClaw Gateway, Tencent Weixin OpenClaw plugin, CodexFocusLock, Clash Verge Rev.

## Global Constraints

- Support Windows 10/11 x64 and run all maintained scripts with PowerShell 7 (`pwsh.exe`), not Windows PowerShell 5.1.
- Build on the existing schema-v1 machine configuration and current checkout portability work; do not reintroduce repository-absolute paths into source or stored task actions.
- The installer must not store WeChat credentials, tokens, or message bodies in reports; `weixinAccount` and `weixinTarget` remain in `machine.json` and are redacted in diagnostic output.
- Unknown Tencent Weixin plugin versions or layouts must fail before modifying package files.
- `SYSTEM` owns protection/recovery tasks; the logged-on interactive user owns desktop application launch tasks.
- A successful file copy, scheduled-task registration, port check, or Gateway health check is not sufficient evidence of end-to-end success.
- Website restrictions must report hosts, browser policy, Clash persistent configuration, Clash live reload, direct access, proxy access, and control-site access independently.
- QQ session results must distinguish authorization, desktop launch, audit refresh, cleanup, and rollback; audit failure after a confirmed launch is a warning, not a false launch failure.
- Installation must be idempotent and resumable. Rerunning a completed phase must not duplicate tasks, lose backups, reset quotas, or broaden blocking rules.
- Existing database content, website quotas, plan history, and current restrictions must be preserved.
- Do not install temperature monitoring; it remains intentionally excluded.

---

## File and Responsibility Map

### Phase A — deployment foundation

- `core/deployment/runtime-descriptor.mjs`: validate and read the generated absolute runtime-path contract.
- `core/deployment/resolve-runtime.ps1`: discover and validate PowerShell, Node, Python, OpenClaw, plugin layout, database, and optional Clash runtime; write `runtime.json` atomically.
- `core/deployment/probe-identity.ps1`: execute a bounded capability probe as the current user, `SYSTEM`, or the logged-on interactive user.
- `core/deployment/task-contract.ps1`: build and verify scheduled-task actions from `runtime.json` so installers do not independently rediscover executables.
- `core/deployment/run-state.mjs`: persist phase results and resume decisions in one deployment report.
- `core/config/install-new-computer.ps1`: become the thin phase orchestrator (`Preflight`, `Configure`, `Install`, `Verify`, `Report`).
- `core/adapter/openclaw-layouts.json`: declare supported Tencent plugin version/layout fingerprints.
- `core/adapter/repair-openclaw-adapter.ps1`: consume the layout registry and inject the stable Plan root into the adapter.
- `core/runtime/plan-root.mjs`: resolve external resources from `MASHIROBOT_PLAN_ROOT`, never from OpenClaw's temporary plugin-capture directory.

### Phase B — truthful feature acceptance

- `plugin/mashirobot-plugin-game-timer/core/qq-session-scheduler.mjs`: return structured QQ side-effect and audit outcomes.
- `plugin/mashirobot-plugin-game-timer/index.mjs`: format partial QQ success accurately and only roll back when authorization/launch failed.
- `plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1`: install both QQ tasks using the shared runtime descriptor, including explicit `-NodePath`.
- `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`: persist per-layer website state and continue checking other layers after one layer fails.
- `core/deployment/accept-new-computer.ps1`: correlate local route tests, scheduled tasks, Gateway logs, real WeChat checks, QQ lifecycle, and website probes into one acceptance report.
- `docs/new-computer-setup.md`: document the supported 20-minute happy path and the exact escalation path when a gate fails.

---

## Phase A: Reliable Deployment Foundation

### Task 1: Define and validate the runtime descriptor

**Files:**
- Create: `core/deployment/runtime-descriptor.mjs`
- Create: `core/deployment/resolve-runtime.ps1`
- Create: `tests/runtime-descriptor.test.mjs`
- Create: `tests/test-runtime-resolution.ps1`
- Modify: `core/config/machine-config.mjs`
- Modify: `core/config/MashiroBot.MachineConfig.ps1`

**Interfaces:**
- Consumes: schema-v1 `machine.json`, repository root, SQLite path, current process environment.
- Produces: `readRuntimeDescriptor({ descriptorPath, env }) -> Readonly<RuntimeDescriptor>` and `%LOCALAPPDATA%\MashiroBot\config\runtime.json` with `schemaVersion`, `planRoot`, `sqlitePath`, `pwshPath`, `nodePath`, `pythonPath`, `openClawCommand`, `openClawPackageRoot`, `openClawPackageVersion`, `openClawLayoutId`, `interactiveUser`, and optional `clash` discovery data.

- [ ] **Step 1: Write the Node contract tests**

```js
test("accepts absolute validated runtime paths", () => {
  const value = readRuntimeDescriptor({ descriptorPath: fixture("runtime.valid.json") });
  assert.equal(value.schemaVersion, 1);
  assert.match(value.pwshPath, /pwsh\.exe$/i);
  assert.equal(path.isAbsolute(value.planRoot), true);
});

test("rejects a relative executable path", () => {
  assert.throws(
    () => readRuntimeDescriptor({ descriptorPath: fixture("runtime.relative-node.json") }),
    /nodePath must be absolute/
  );
});
```

- [ ] **Step 2: Run the Node test and verify the missing module failure**

Run: `node --test tests/runtime-descriptor.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `core/deployment/runtime-descriptor.mjs`.

- [ ] **Step 3: Implement the immutable descriptor reader**

```js
export function readRuntimeDescriptor({ descriptorPath = runtimeDescriptorPath(), readFile = fs.readFileSync } = {}) {
  const value = JSON.parse(readFile(descriptorPath, "utf8"));
  if (value?.schemaVersion !== 1) throw new Error(`Unsupported runtime descriptor schemaVersion in ${descriptorPath}`);
  for (const key of ["planRoot", "sqlitePath", "pwshPath", "nodePath", "pythonPath", "openClawCommand", "openClawPackageRoot"]) {
    if (!path.isAbsolute(String(value[key] ?? ""))) throw new Error(`${key} must be absolute in ${descriptorPath}`);
  }
  return Object.freeze(structuredClone(value));
}
```

- [ ] **Step 4: Write PowerShell fixtures for good discovery and unsupported Python**

The test must inject fake executables through parameters instead of mutating the real machine and assert that Python 3.14 is rejected with this exact diagnostic:

```powershell
Assert-Contains $Result.stderr 'Python 3.14 is not in the validated range 3.11-3.13'
Assert-False (Test-Path -LiteralPath $OutputPath) 'failed discovery must not publish runtime.json'
```

- [ ] **Step 5: Implement atomic discovery and capability checks**

`resolve-runtime.ps1` must invoke the resolved binaries, not only inspect filenames:

```powershell
& $NodePath -e 'require("node:sqlite"); process.stdout.write(process.execPath)'
& $PythonPath -c 'import sqlite3; from PIL import Image; print("ok")'
& $PwshPath -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
```

Write to `runtime.json.tmp`, reread it, then use `Move-Item -Force` only after every required capability passes. Record optional Clash discovery as `{ installed, configRoot, liveConfigPath, reloadTransports }`; absence of Clash is not a core deployment failure.

- [ ] **Step 6: Preserve machine configuration schema v1 and expose the descriptor path**

Add `Resolve-MashiroRuntimeDescriptorPath` to the PowerShell module and `runtimeDescriptorPath(env)` to the Node module. Do not put generated runtime fields into `machine.json`.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
node --test tests/runtime-descriptor.test.mjs tests/machine-config.test.mjs
pwsh -NoProfile -File tests/test-runtime-resolution.ps1
pwsh -NoProfile -File tests/test-machine-config.ps1
```

Expected: all PASS; the invalid fixture leaves no published descriptor.

- [ ] **Step 8: Commit**

```powershell
git add core/deployment/runtime-descriptor.mjs core/deployment/resolve-runtime.ps1 core/config/machine-config.mjs core/config/MashiroBot.MachineConfig.ps1 tests/runtime-descriptor.test.mjs tests/test-runtime-resolution.ps1
git commit -m "feat: add validated deployment runtime descriptor"
```

### Task 2: Add identity-specific preflight probes

**Files:**
- Create: `core/deployment/probe-identity.ps1`
- Create: `tests/test-deployment-preflight.ps1`
- Modify: `core/deployment/resolve-runtime.ps1`

**Interfaces:**
- Consumes: `runtime.json`, `-Identity CurrentUser|System|InteractiveUser`, `-ProbeRoot`.
- Produces: one JSON object `{ ok, identity, executables, database, resources, checkedAt, errors }`; the resolver aggregates the three objects under `identityProbes`.

- [ ] **Step 1: Write failing fixture-mode tests for all three identities**

Use `-ProbeRoot` to avoid creating real scheduled tasks. Assert the same absolute `pwshPath`, `nodePath`, `pythonPath`, `planRoot`, and `sqlitePath` appear in every probe and that a missing `planner.py` makes only `resources.ok` false with the exact missing path.

- [ ] **Step 2: Run the preflight test**

Run: `pwsh -NoProfile -File tests/test-deployment-preflight.ps1`

Expected: FAIL because `probe-identity.ps1` does not exist.

- [ ] **Step 3: Implement the bounded probe payload**

The payload must check:

```powershell
$Result.executables.node = Test-Path -LiteralPath $Runtime.nodePath -PathType Leaf
$Result.database.readable = Test-Path -LiteralPath $Runtime.sqlitePath -PathType Leaf
$Result.resources = @{
    planner = Test-Path -LiteralPath (Join-Path $Runtime.planRoot 'plugin\mashirobot-plugin-plan\planner\planner.py')
    games = Test-Path -LiteralPath (Join-Path $Runtime.planRoot 'plugin\mashirobot-plugin-game-timer\core\games.json')
    helpRenderer = Test-Path -LiteralPath (Join-Path $Runtime.planRoot 'core\menu\render_help.py')
}
```

Each probe gets a 20-second execution limit and writes UTF-8 JSON to a per-run temporary directory.

- [ ] **Step 4: Add real Task Scheduler execution for `SYSTEM` and interactive user**

Create uniquely named one-shot tasks `MashiroBot-DeployProbe-<runId>-System` and `MashiroBot-DeployProbe-<runId>-Interactive`, wait for their JSON files, export their XML for evidence, and unregister them in `finally`. The interactive task principal must be the descriptor's `interactiveUser`; do not infer it while running as `SYSTEM`.

- [ ] **Step 5: Reject install when a required identity fails**

`resolve-runtime.ps1` must leave the descriptor unpublished and return nonzero when any required probe has `ok:false`. Include the identity, failed capability, actual path, and task last-result code in the error.

- [ ] **Step 6: Run the preflight tests in fixture mode and one elevated live smoke test**

Run:

```powershell
pwsh -NoProfile -File tests/test-deployment-preflight.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File core/deployment/resolve-runtime.ps1 -ProbeIdentities
```

Expected: fixtures PASS; live run reports three successful identities or stops before installation with a specific failed identity.

- [ ] **Step 7: Commit**

```powershell
git add core/deployment/probe-identity.ps1 core/deployment/resolve-runtime.ps1 tests/test-deployment-preflight.ps1
git commit -m "feat: verify deployment paths under real Windows identities"
```

### Task 3: Make OpenClaw adaptation versioned and resource-root safe

**Files:**
- Create: `core/adapter/openclaw-layouts.json`
- Create: `core/runtime/plan-root.mjs`
- Create: `tests/plan-root.test.mjs`
- Modify: `core/adapter/fast-routine.adapter.js`
- Modify: `core/adapter/repair-openclaw-adapter.ps1`
- Modify: `tests/test_adapter_repair.ps1`
- Modify: `core/index.mjs`

**Interfaces:**
- Consumes: Tencent package `package.json`, known file fingerprints, `runtime.json`.
- Produces: `resolvePlanRoot({ env, moduleUrl }) -> string`; adapter repair result `{ ok, packageVersion, layoutId, changedFiles, backups }`.

- [ ] **Step 1: Add failing tests for temporary plugin capture and unknown package layout**

```js
test("MASHIROBOT_PLAN_ROOT overrides a captured module URL", () => {
  const root = resolvePlanRoot({
    env: { MASHIROBOT_PLAN_ROOT: "D:\\repo\\plan" },
    moduleUrl: "file:///C:/Users/test/.openclaw/plugin-captures/random/core/index.mjs"
  });
  assert.equal(root, "D:\\repo\\plan");
});
```

Extend `test_adapter_repair.ps1` with package versions `2.4.8`, one legacy known fixture, and `9.9.9` with a different hash. The last case must exit nonzero without backups or writes.

- [ ] **Step 2: Run both test suites and verify failure**

Run:

```powershell
node --test tests/plan-root.test.mjs
pwsh -NoProfile -File tests/test_adapter_repair.ps1
```

Expected: missing resolver failure and missing layout-registry assertion failure.

- [ ] **Step 3: Implement the stable Plan-root resolver**

```js
export function resolvePlanRoot({ env = process.env, moduleUrl = import.meta.url } = {}) {
  const explicit = String(env.MASHIROBOT_PLAN_ROOT ?? "").trim();
  if (explicit) return path.resolve(explicit);
  const inferred = path.resolve(fileURLToPath(new URL("../..", moduleUrl)));
  if (inferred.toLowerCase().includes(`${path.sep}plugin-captures${path.sep}`)) {
    throw new Error("MASHIROBOT_PLAN_ROOT is required when OpenClaw loads a captured plugin copy");
  }
  return inferred;
}
```

Update `core/index.mjs` to use this root for all external resources.

- [ ] **Step 4: Define explicit supported layouts**

`openclaw-layouts.json` entries must contain `id`, `versionRange`, `fastRoutinePath`, `processMessagePath`, and marker lists. Include the currently observed Tencent 2.4.8 `dist/src/messaging/process-message.js` layout and the already tested legacy fast-routine layout. Do not add a wildcard layout.

- [ ] **Step 5: Generate an adapter that sets the stable root before importing MashiroBot**

The canonical adapter must set `process.env.MASHIROBOT_PLAN_ROOT` from the absolute root injected by the repair script, then dynamically import `core/index.mjs`. Preserve the exported `handleFastRoutineCommand` name expected by Tencent.

- [ ] **Step 6: Make repair transactional and machine-readable**

Before writes: resolve exactly one package, read its version, match exactly one registry entry, validate all markers, and report the intended edits. After writes: run `node --check` on both files and import the adapter in a child Node process with `MASHIROBOT_PLAN_ROOT` set. On any failure, restore both backups and return JSON with `restored:true`.

- [ ] **Step 7: Run adapter, route, and capture-root tests**

Run:

```powershell
node --test tests/plan-root.test.mjs tests/router.test.mjs
pwsh -NoProfile -File tests/test_adapter_repair.ps1
```

Expected: all PASS; the capture-root fixture loads `planner.py`, `games.json`, and the help renderer from the repository root.

- [ ] **Step 8: Commit**

```powershell
git add core/adapter/openclaw-layouts.json core/runtime/plan-root.mjs core/adapter/fast-routine.adapter.js core/adapter/repair-openclaw-adapter.ps1 core/index.mjs tests/plan-root.test.mjs tests/test_adapter_repair.ps1
git commit -m "fix: harden OpenClaw adapter and resource root discovery"
```

### Task 4: Centralize scheduled-task actions and runtime arguments

**Files:**
- Create: `core/deployment/task-contract.ps1`
- Create: `tests/test-task-contract.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/install-block.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/game-locker/powershell/install-game-locker.ps1`
- Modify: `plugin/mashirobot-plugin-loot/windows/install.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1`

**Interfaces:**
- Consumes: `New-MashiroTaskAction -Runtime $runtime -WorkerPath <absolute> -Arguments <string[]>`.
- Produces: a task action with absolute `Execute`; `Assert-MashiroTaskContract -TaskName -ExpectedPrincipal -RequiredArguments` returns exported XML evidence or throws.

- [ ] **Step 1: Write failing quoting and principal tests**

Test paths containing spaces and Chinese characters. Assert both QQ tasks contain absolute `pwshPath`, `-NodePath "<absolute node.exe>"`, `-RuntimeDescriptorPath`, and the correct worker path. Assert reconcile principal is `SYSTEM` and launch principal is the descriptor's interactive user.

- [ ] **Step 2: Run the task-contract test**

Run: `pwsh -NoProfile -File tests/test-task-contract.ps1`

Expected: FAIL because `New-MashiroTaskAction` is undefined.

- [ ] **Step 3: Implement argument quoting and exported-XML verification**

The module must reject newline/NUL characters and quote each argument independently. Verification must compare normalized executable paths, principal identity, logon type, run level, worker path, runtime descriptor path, and every explicit runtime executable argument.

- [ ] **Step 4: Convert installers one at a time**

Add mandatory `-RuntimeDescriptorPath` to each install mode and replace `Get-Command`, plain `node`, plain `python`, and plain `pwsh` in stored task actions with descriptor values. Retain each worker's existing state root and privilege model.

- [ ] **Step 5: Add `-NodePath` to both QQ worker actions**

Both `Watch` and `LaunchInteractive` must receive the same Node path. Update the QQ worker parameter list and every Node child invocation to use that value.

- [ ] **Step 6: Run installer contract tests without registering live tasks**

Run:

```powershell
pwsh -NoProfile -File tests/test-task-contract.ps1
pwsh -NoProfile -File tests/test-machine-path-policy.ps1
node --test plugin/mashirobot-plugin-game-timer/tests/qq-scheduler.test.mjs
```

Expected: all PASS and no stored action relies on `PATH` for PowerShell, Node, or Python.

- [ ] **Step 7: Commit**

```powershell
git add core/deployment/task-contract.ps1 tests/test-task-contract.ps1 plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1 plugin/mashirobot-plugin-game-timer/block/powershell/install-block.ps1 plugin/mashirobot-plugin-game-timer/game-locker/powershell/install-game-locker.ps1 plugin/mashirobot-plugin-loot/windows/install.ps1 plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1
git commit -m "refactor: install tasks from one runtime contract"
```

### Task 5: Replace the linear installer with resumable phases

**Files:**
- Create: `core/deployment/run-state.mjs`
- Create: `tests/deployment-run-state.test.mjs`
- Create: `tests/test-install-orchestrator.ps1`
- Modify: `core/config/install-new-computer.ps1`
- Modify: `core/health/check-mashirobot.ps1`

**Interfaces:**
- Consumes: `-Action Preflight|Configure|Install|Verify|Report|All`, `-RunId`, `-Resume`, `-Profile Core|Standard|Full`, `-RuntimeDescriptorPath`.
- Produces: `%LOCALAPPDATA%\MashiroBot\deployments\<runId>\report.json`; phase states are `pending|running|passed|failed|skipped|unverified`.

- [ ] **Step 1: Write failing run-state tests**

```js
test("resume starts at the first non-passed phase", () => {
  const state = createRunState({ phases: ["preflight", "configure", "backup", "install", "verify"] });
  state.phases.preflight.status = "passed";
  state.phases.configure.status = "passed";
  assert.equal(nextPhase(state), "backup");
});

test("a warning cannot become passed", () => {
  assert.equal(summarizeRun({ requiredFailures: [], warnings: ["audit refresh failed"] }), "completed_with_warnings");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/deployment-run-state.test.mjs`

Expected: missing module failure.

- [ ] **Step 3: Implement atomic run-state persistence and redaction**

Every phase records `startedAt`, `finishedAt`, `exitCode`, `status`, `evidencePaths`, `warnings`, and `error`. Redact keys matching `/token|secret|password|credential|weixinTarget/i`; store only the last four characters of target identifiers.

- [ ] **Step 4: Write orchestrator fixture tests**

Use fake child scripts whose exit codes are configurable. Assert: every child exit code is checked; a failed adapter phase prevents task installation; `-Resume` skips passed phases; rerun does not create duplicate tasks; `Core` excludes FocusLock/game/QQ/block; `Standard` includes them; financial report remains opt-in.

- [ ] **Step 5: Refactor the installer into explicit phases**

Use this order and stop policy:

```text
preflight -> configure -> backup -> adapter -> gateway-watchdog -> core-features
-> optional-features -> gateway-start -> static-verify -> acceptance -> report
```

Back up `machine.json`, SQLite, adapter targets, and generated worker configs before mutations. A required phase failure stops later mutation phases; report generation always runs in `finally`.

- [ ] **Step 6: Separate health modes**

Keep `check-mashirobot.ps1 -PreStart` non-destructive. Add `-Static` for files/config/task definitions and `-Runtime` for task last results, worker heartbeats, Gateway reachability, and temporary help rendering. Neither mode may claim real WeChat acceptance.

- [ ] **Step 7: Run orchestrator and health contract tests**

Run:

```powershell
node --test tests/deployment-run-state.test.mjs tests/health-contract.test.mjs
pwsh -NoProfile -File tests/test-install-orchestrator.ps1
pwsh -NoProfile -File tests/test-machine-path-policy.ps1
```

Expected: all PASS; the fixture report retains the first real failing child and marks later phases `skipped`.

- [ ] **Step 8: Commit**

```powershell
git add core/deployment/run-state.mjs core/config/install-new-computer.ps1 core/health/check-mashirobot.ps1 tests/deployment-run-state.test.mjs tests/test-install-orchestrator.ps1
git commit -m "feat: make new-computer deployment resumable and auditable"
```

---

## Phase B: Truthful Feature Acceptance

### Task 6: Separate QQ authorization, launch, audit, and rollback results

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-scheduler.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/index.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/tests/qq-scheduler.test.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`

**Interfaces:**
- Consumes: current QQ worker status and session record.
- Produces: `begin()` result `{ session, launch: { ok, processActive, executablePaths }, audit: { ok, warning }, rollback: { attempted, ok } }`.

- [ ] **Step 1: Add failing tests for confirmed launch plus audit failure**

```js
test("keeps confirmed QQ launch successful when audit refresh fails", async () => {
  const result = await plugin.handle("玩QQ10分钟", contextWith({ launchOk: true, auditError: "targets unavailable" }));
  assert.match(result.content, /QQ已允许使用 10 分钟/);
  assert.match(result.content, /使用审计刷新失败/);
  assert.equal(context.scheduler.recoverCalls, 0);
});
```

Also cover launch failure before process confirmation, failed cleanup after session end, and explicit rollback failure.

- [ ] **Step 2: Run QQ tests and verify the false-failure case fails**

Run: `node --test plugin/mashirobot-plugin-game-timer/tests/qq-scheduler.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs`

Expected: the audit-warning test FAILS because the current result has no separated audit outcome.

- [ ] **Step 3: Return a structured launch result at the confirmation boundary**

The scheduler marks `launch.ok:true` only after matching session id, active authorization, installed QQ, and an interactive QQ process. Subsequent audit refresh errors populate `audit.warning` and must not throw `QQ_START_UNVERIFIED`.

- [ ] **Step 4: Restrict rollback to failed authorization or failed launch**

If authorization was persisted but launch never confirmed, call `recover()` and report both the original failure and rollback result. Never roll back a confirmed session merely because audit target refresh failed.

- [ ] **Step 5: Render precise user messages**

Use these outcome classes: `成功`, `成功但审计有警告`, `启动失败且已回滚`, `启动失败且回滚也失败`. Do not convert unmatched local commands or local plugin exceptions into an AI fallback.

- [ ] **Step 6: Run JS and PowerShell QQ suites**

Run:

```powershell
node --test plugin/mashirobot-plugin-game-timer/tests/qq-scheduler.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
```

Expected: all PASS, including the interactive task receiving explicit Node path from Task 4.

- [ ] **Step 7: Commit**

```powershell
git add plugin/mashirobot-plugin-game-timer/core/qq-session-scheduler.mjs plugin/mashirobot-plugin-game-timer/index.mjs plugin/mashirobot-plugin-game-timer/tests/qq-scheduler.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
git commit -m "fix: report QQ launch and audit outcomes independently"
```

### Task 7: Track and verify every website-control layer independently

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/install-block.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`
- Create: `core/deployment/test-website-layers.ps1`
- Create: `tests/test-website-layer-report.ps1`

**Interfaces:**
- Consumes: effective block rows, release rows, Clash discovery from `runtime.json`, test URLs.
- Produces: `LastSync.layers` with `hosts`, `browserPolicy`, `clashPersistent`, `clashReload`, `directProbe`, `proxyProbe`, and `controlProbe`; aggregate `ok` is true only when every required installed layer is true.

- [ ] **Step 1: Add failing layer-state tests**

Create fixtures where Clash reload fails but hosts and browser policy succeed. Assert `LastSync.layers.clashReload.ok` is false, other layer evidence remains present, and the worker exits nonzero only after all layers have been attempted.

- [ ] **Step 2: Run worker tests and verify the early-abort failure**

Run: `pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`

Expected: the new fixture FAILS because current `Set-ClashRules` throws before a complete per-layer report is stored.

- [ ] **Step 3: Implement best-effort layer collection**

Wrap each layer in a result collector that records `{ ok, required, evidence, error, checkedAt }`. Continue to later layers after an error, save `LastSync` once, then return nonzero if any required layer failed.

- [ ] **Step 4: Discover Clash's live core instead of assuming one path**

Use the runtime descriptor's config root, live generated config, controller endpoint/pipe, and actual process command line. Persistent rule write and live reload are separate results; do not report reload success from file contents alone.

- [ ] **Step 5: Add bounded direct/proxy/control probes**

`test-website-layers.ps1` receives explicit blocked and control URLs. Each request has a five-second timeout and records DNS/connection/HTTP outcome without storing page content. When no proxy is installed, mark proxy probe `skipped`, not `passed`.

- [ ] **Step 6: Run layer tests and a live status-only probe**

Run:

```powershell
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
pwsh -NoProfile -File tests/test-website-layer-report.ps1
pwsh -NoProfile -File core/deployment/test-website-layers.ps1 -StatusOnly
```

Expected: tests PASS; live output names each layer and never collapses a Clash reload failure into a generic website failure.

- [ ] **Step 7: Commit**

```powershell
git add plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1 plugin/mashirobot-plugin-game-timer/block/powershell/install-block.ps1 plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1 core/deployment/test-website-layers.ps1 tests/test-website-layer-report.ps1
git commit -m "fix: verify website restrictions by enforcement layer"
```

### Task 8: Add end-to-end acceptance, evidence, and deployment documentation

**Files:**
- Create: `core/deployment/accept-new-computer.ps1`
- Create: `tests/test-deployment-acceptance.ps1`
- Modify: `core/config/install-new-computer.ps1`
- Modify: `docs/new-computer-setup.md`
- Modify: `new-computer-deployment-retrospective-2026-09-29.md`

**Interfaces:**
- Consumes: run report, runtime descriptor, health JSON, Gateway logs, worker state files, operator confirmations for real WeChat responses.
- Produces: `acceptance.json` with evidence levels `static|runtime|end_to_end|human_confirmed`; overall status `passed|failed|unverified|completed_with_warnings`.

- [ ] **Step 1: Write failing acceptance-state tests**

Test that static health plus Gateway port produces `unverified`, not `passed`; a real routed `帮助` response and `查询今日计划` response can become `human_confirmed`; missing QQ cleanup evidence fails only the QQ lifecycle check, not unrelated checks.

- [ ] **Step 2: Run the acceptance test**

Run: `pwsh -NoProfile -File tests/test-deployment-acceptance.ps1`

Expected: FAIL because `accept-new-computer.ps1` does not exist.

- [ ] **Step 3: Implement automated acceptance checks**

Automate these checks before asking for human confirmation:

```text
1. Local parser recognizes documented commands and rejects an invented command locally.
2. Gateway restart succeeds and the adapter/resource-root checks still pass afterward.
3. Scheduled-task XML, last result, and worker heartbeat agree for every installed feature.
4. Help image renders through the same root and Python selected for Gateway execution.
5. Website layer report contains a result for every installed enforcement layer.
6. QQ status proves protection posture before any optional short lifecycle test.
```

- [ ] **Step 4: Add the real WeChat confirmation gate**

Prompt the operator to send the commands listed by the actual local help/parser: `帮助`, `状态`, and `查询今日计划`. For each, record timestamp, expected local route id, observed reply class, and matching Gateway log event. Never ask the operator to use an unverified command from memory.

- [ ] **Step 5: Add an optional QQ lifecycle gate**

The gate is opt-in because it launches QQ. It must capture: protected before request, interactive process confirmed during a short session, process closed at expiry, startup file returned to the protected directory, cooldown active, and permanent website restriction restored. A skipped gate remains `unverified`.

- [ ] **Step 6: Update the setup guide to the 20-minute path**

Document this operator flow:

```text
0-3 min   Preflight and identity probes
3-8 min   Machine config, runtime descriptor, database backup
8-12 min  Adapter and scheduled-task installation
12-18 min Static/runtime checks plus real WeChat acceptance
18-20 min Save report, list warnings/unverified gates, retain rollback paths
```

Add a diagnostic decision tree in this order: message arrival -> local route match -> child process path/exit/stderr -> reproduce under same identity -> inspect same failure class -> one restart -> repeat acceptance.

- [ ] **Step 7: Run the complete non-destructive suite**

Run:

```powershell
node --test tests/*.test.mjs
pwsh -NoProfile -File tests/test-machine-config.ps1
pwsh -NoProfile -File tests/test-machine-path-policy.ps1
pwsh -NoProfile -File tests/test-runtime-resolution.ps1
pwsh -NoProfile -File tests/test-deployment-preflight.ps1
pwsh -NoProfile -File tests/test-task-contract.ps1
pwsh -NoProfile -File tests/test-install-orchestrator.ps1
pwsh -NoProfile -File tests/test-deployment-acceptance.ps1
```

Expected: all PASS without changing live restrictions, launching QQ, or sending WeChat messages.

- [ ] **Step 8: Perform one disposable-machine rehearsal**

Run `install-new-computer.ps1 -Action All -Profile Standard` on a clean Windows test machine, complete the three real WeChat confirmations, restart the Gateway once, and save the generated `report.json` and `acceptance.json`. Record elapsed time per phase; the target is at most 20 minutes excluding downloads and the optional QQ lifecycle duration.

- [ ] **Step 9: Update the retrospective with measured results**

Append only the observed phase timings, failed gates, exact recovery action, and whether rerunning with `-Resume` avoided repeating passed phases. Do not rewrite the original incident narrative.

- [ ] **Step 10: Commit**

```powershell
git add core/deployment/accept-new-computer.ps1 core/config/install-new-computer.ps1 tests/test-deployment-acceptance.ps1 docs/new-computer-setup.md new-computer-deployment-retrospective-2026-09-29.md
git commit -m "docs: add evidence-based new-computer acceptance flow"
```

---

## Release Gate

The deployment hardening is complete only when all of the following are true:

- A failed current-user, `SYSTEM`, or interactive-user probe prevents mutation and names the exact missing path or capability.
- A supported Tencent plugin version repairs idempotently; an unknown layout remains untouched.
- OpenClaw temporary plugin capture cannot redirect Plan Bot resource lookup away from the repository root.
- Every scheduled task contains explicit absolute PowerShell, Node, Python, worker, database, and runtime-descriptor paths as applicable.
- An interrupted installation resumes from the first non-passed phase and preserves database/configuration backups.
- QQ confirmed launch remains successful when only audit refresh fails, and rollback status is reported independently.
- Website status contains independent evidence for hosts, browser policy, persistent Clash config, live reload, direct path, proxy path, and control site.
- Gateway restart is followed by repeated route/resource checks.
- Real WeChat `帮助`, `状态`, and `查询今日计划` checks are recorded as human-confirmed end-to-end evidence.
- The final report uses `unverified` for any skipped real-world gate and never upgrades static evidence to end-to-end success.
- One clean-machine rehearsal finishes the standard path within 20 minutes excluding downloads and optional QQ session duration.

## Self-Review Results

- Spec coverage: all incidents in the 2026-09-29 retrospective map to Tasks 1-8; existing machine-path portability is reused rather than repeated.
- Placeholder scan: no deferred implementation markers or unspecified error-handling steps remain.
- Interface consistency: `runtime.json` is produced in Task 1, identity-verified in Task 2, consumed by Tasks 3-5 and feature installers, then included in Task 8 evidence.
- Scope split: Phase A can ship independently as safer deployment infrastructure; Phase B can ship independently afterward as truthful feature-level acceptance.
