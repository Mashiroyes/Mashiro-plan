# MashiroBot Project Performance and Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove blocking external-process work from MashiroBot’s message path, eliminate known redundant calls, and require verified outcomes before local plugins report success.

**Architecture:** Convert the core route boundary to async while retaining compatibility with synchronous plugin functions. Add one bounded, testable process runner and one atomic content cache, then migrate each in-scope plugin independently; system-changing operations retain their existing PowerShell boundary but must publish and verify authoritative state.

**Tech Stack:** Node.js ESM and `node:test`, PowerShell 7, Python 3/Pillow, SQLite (`node:sqlite` and Python sqlite3), Windows Task Scheduler, OpenClaw WeChat adapter.

**Spec:** `plan/docs/superpowers/specs/2026-09-16-project-performance-robustness-design.md`

## Global Constraints

- Do not modify any file under `plan/plugin/mashirobot-plugin-financial-report`.
- Generate and compare a relative-path, size, and SHA-256 manifest for the excluded plugin before and after implementation.
- Preserve every existing command, response meaning, database record, and scheduled-task behavior unless the spec explicitly changes implementation details.
- Do not use `execFileSync`, `spawnSync`, `Atomics.wait`, or synchronous sleeps in the message-processing path.
- Spawn child processes without a shell and pass every argument as a separate array element.
- Do not report a system-changing action as successful until its authoritative state is verified.
- Matched local failures remain local and must never fall through to GPT.
- Every plugin-side process launch must use `context.runLocalProcess` when present, falling back to the shared runner only for offline tools; this preserves request-level external-process metrics and test injection.
- Do not automatically trigger destructive live QQ, game-process, or real reminder actions during verification.
- Use PowerShell 7 (`pwsh.exe`) for Windows automation.
- The workspace contains an empty `.git` directory and is not currently a valid Git repository. Do not initialize or repair Git without user authorization. At each commit step, record the listed files and SHA-256 hashes instead; run the Git command only if `git rev-parse --is-inside-work-tree` succeeds at execution time.

---

### Task 1: Freeze the exclusion boundary and record reproducible baselines

**Files:**
- Create: `plan/tools/plugin-integrity.ps1`
- Create: `plan/tools/benchmark-local-routes.mjs`
- Create: `plan/tests/plugin-integrity.test.mjs`
- Read only: `plan/plugin/mashirobot-plugin-financial-report/**`

**Interfaces:**
- Produces: `plugin-integrity.ps1 -Mode Snapshot|Compare -PluginPath <path> -SnapshotPath <json>`.
- Produces: benchmark JSON records shaped as `{ command, samplesMs, medianMs, maxMs, externalStarts }`.
- Consumes: no implementation tasks; this is the immutable before-state gate.

- [ ] **Step 1: Write a failing integrity-tool test**

Create a temporary plugin tree, snapshot it, alter one file, and assert compare mode exits nonzero and names the changed relative path:

```js
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const execPwsh = (args) => execFileAsync("pwsh.exe", ["-NoProfile", "-File", ...args], {
  encoding: "utf8",
  windowsHide: true,
});

test("integrity comparison detects changed bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-integrity-"));
  const snapshot = path.join(root, "snapshot.json");
  const plugin = path.join(root, "plugin");
  await mkdir(plugin);
  await writeFile(path.join(plugin, "index.mjs"), "export const value = 1;\n");
  await execPwsh([tool, "-Mode", "Snapshot", "-PluginPath", plugin, "-SnapshotPath", snapshot]);
  await writeFile(path.join(plugin, "index.mjs"), "export const value = 2;\n");
  await assert.rejects(
    execPwsh([tool, "-Mode", "Compare", "-PluginPath", plugin, "-SnapshotPath", snapshot]),
    /index\.mjs/,
  );
});
```

- [ ] **Step 2: Run the test and verify the tool is absent**

Run:

```powershell
node --test plan/tests/plugin-integrity.test.mjs
```

Expected: FAIL because `plan/tools/plugin-integrity.ps1` does not exist.

- [ ] **Step 3: Implement deterministic snapshot and comparison modes**

The PowerShell script must sort by relative path and serialize only stable fields:

```powershell
$Rows = Get-ChildItem -LiteralPath $PluginPath -Recurse -File | ForEach-Object {
    [ordered]@{
        path = [IO.Path]::GetRelativePath((Resolve-Path $PluginPath), $_.FullName).Replace('\','/')
        size = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
} | Sort-Object path
```

`Snapshot` writes UTF-8 JSON atomically through a sibling temporary file. `Compare` loads the snapshot, compares exact JSON-normalized rows, writes changed/added/removed paths to stderr, and exits `2` on any difference.

- [ ] **Step 4: Implement a non-mutating baseline benchmark**

`benchmark-local-routes.mjs` must accept `--output <json>`, run injected or fixture-backed calls for `查看游戏`, `查看游戏计时`, `爽点` save, cached help, and cached/uncached rendering, and record at least five samples per pure local route. Use `performance.now()` and expose an injected external-start counter so later tests can prove “加入游戏” starts zero QQ/PowerShell processes.

- [ ] **Step 5: Run the integrity test, baseline tests, and capture the excluded-plugin snapshot**

Run:

```powershell
node --test plan/tests/plugin-integrity.test.mjs
$guardRoot = Join-Path $env:LOCALAPPDATA 'MashiroBot\integrity'
New-Item -ItemType Directory -Path $guardRoot -Force | Out-Null
pwsh.exe -NoProfile -File plan/tools/plugin-integrity.ps1 -Mode Snapshot `
  -PluginPath plan/plugin/mashirobot-plugin-financial-report `
  -SnapshotPath (Join-Path $guardRoot 'financial-report-before.json')
$tests = @(rg --files plan -g '*.test.mjs' -g '!**/mashirobot-plugin-financial-report/**')
node --test @tests
node plan/tools/benchmark-local-routes.mjs --output (Join-Path $guardRoot 'performance-before.json')
```

Expected: integrity test PASS; existing non-financial suite reports 126 pass and 2 skipped or a documented higher passing count; baseline JSON is created outside the project.

- [ ] **Step 6: Record the checkpoint**

If Git is valid:

```powershell
git add plan/tools/plugin-integrity.ps1 plan/tools/benchmark-local-routes.mjs plan/tests/plugin-integrity.test.mjs
git commit -m "test: capture mashirobot performance and exclusion baselines"
```

Otherwise write `Task 1` plus `Get-FileHash` output for the three files to `plan/docs/superpowers/plans/2026-09-16-project-performance-robustness.checkpoints.txt`.

---

### Task 2: Add the bounded asynchronous local-process runner

**Files:**
- Create: `plan/core/execution/local-process.mjs`
- Create: `plan/tests/local-process.test.mjs`

**Interfaces:**
- Produces: `runLocalProcess(options) -> Promise<LocalProcessResult>`.
- Produces: `LocalProcessError` with `code`, `operationId`, `elapsedMs`, `exitCode`, `stdout`, and `stderr`.
- `options`: `{ executable, args, cwd, env, timeoutMs, maxStdoutBytes, maxStderrBytes, output, jsonMode, signal, operationId, spawnImpl, killTreeImpl, onComplete }`.
- `LocalProcessResult`: `{ operationId, exitCode, stdout, stderr, elapsedMs, value }`.

- [ ] **Step 1: Write failing tests for success, JSON, timeout, cancellation, and output bounds**

Use `process.execPath` so tests do not depend on PowerShell:

```js
test("returns parsed JSON and elapsed time", async () => {
  const result = await runLocalProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ok:true}))"],
    output: "json",
    timeoutMs: 2_000,
  });
  assert.deepEqual(result.value, { ok: true });
  assert.ok(result.elapsedMs >= 0);
});

test("kills a timed-out process with a stable error code", async () => {
  await assert.rejects(
    runLocalProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      timeoutMs: 50,
    }),
    (error) => error.code === "PROCESS_TIMEOUT" && error.elapsedMs >= 50,
  );
});

test("rejects stdout beyond the configured bound", async () => {
  await assert.rejects(
    runLocalProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(2048))"],
      maxStdoutBytes: 1024,
    }),
    (error) => error.code === "PROCESS_OUTPUT_LIMIT",
  );
});
```

Add equivalent assertions for nonzero exit, malformed JSON, last-JSON-line mode, external `AbortController`, spawn failure, and exactly-once settlement.

- [ ] **Step 2: Run the tests and verify imports fail**

Run:

```powershell
node --test plan/tests/local-process.test.mjs
```

Expected: FAIL with module-not-found for `local-process.mjs`.

- [ ] **Step 3: Implement `LocalProcessError` and bounded stream accumulation**

Use `spawn(executable, args, { shell: false, windowsHide: true })`. Count bytes from Buffer chunks before decoding. On limit, timeout, or abort, set one terminal reason, invoke `killTreeImpl`, and settle only after `close` or a bounded kill grace period.

```js
export class LocalProcessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LocalProcessError";
    this.code = code;
    Object.assign(this, details);
  }
}
```

The Windows default kill implementation must spawn `taskkill.exe` with `[/PID, String(pid), /T, /F]`; non-Windows uses `child.kill("SIGKILL")`. Neither path uses a shell.

Invoke `onComplete({ operationId, elapsedMs, code, exitCode })` exactly once in `finally`, for success and failure alike. This callback contains no stdout, stderr, arguments, or environment values.

- [ ] **Step 4: Implement JSON modes and redacted error details**

Support `output: "text" | "json"` and `jsonMode: "document" | "last-line"`. Preserve bounded stdout/stderr on the error object for tests, but the caller-facing formatter later truncates and redacts them.

- [ ] **Step 5: Run focused and full non-financial tests**

Run:

```powershell
node --test plan/tests/local-process.test.mjs
$tests = @(rg --files plan -g '*.test.mjs' -g '!**/mashirobot-plugin-financial-report/**')
node --test @tests
```

Expected: all runner tests and the existing suite PASS.

- [ ] **Step 6: Record the checkpoint**

Commit `local-process.mjs` and its test if Git is valid; otherwise append their hashes under `Task 2` in the checkpoint file.

---

### Task 3: Convert the core route boundary and installed adapter contract to async

**Files:**
- Modify: `plan/core/router/plugin-router.mjs`
- Modify: `plan/core/loader/plugin-loader.mjs`
- Modify: `plan/core/index.mjs`
- Modify: `plan/core/bridge/context.mjs`
- Modify: `plan/core/adapter/repair-openclaw-adapter.ps1`
- Modify: `plan/core/logging/logger.mjs`
- Modify: `plan/tests/plugin-router.test.mjs`
- Modify: `plan/tests/plugin-loader.test.mjs`
- Modify: `plan/tests/test_adapter_repair.ps1`
- Create: `plan/tests/router-concurrency.test.mjs`

**Interfaces:**
- Produces: `handleMashiroBotMessage(rawText, context) -> Promise<PluginResult|null>`.
- Produces: router support for either plain or promised values from plugin `handle`, `healthCheck`, and help rendering.
- Produces: log records with `requestId`, `pluginId`, `event`, `elapsedMs`, `externalElapsedMs`, `errorCode`, and `message`.
- Produces: `context.runLocalProcess(options)`, a request-scoped wrapper that forwards to Task 2 and accumulates `externalElapsedMs` through `onComplete`.

- [ ] **Step 1: Add failing async compatibility and concurrency tests**

```js
test("awaits an asynchronous plugin and keeps failures local", async () => {
  const plugin = fakePlugin({
    match: () => true,
    handle: async () => { throw new Error("async boom"); },
  });
  const route = createPluginRouter({ registry: registryFor(plugin), planRoot: fixtureRoot });
  const result = await route("command");
  assert.equal(result.command, "插件错误");
  assert.match(result.reply, /async boom/);
});

test("one slow route does not block a second message", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const route = createPluginRouter({ registry: concurrentRegistry(gate), planRoot: fixtureRoot });
  const slow = route("slow");
  const fast = await Promise.race([
    route("fast"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("blocked")), 100)),
  ]);
  assert.equal(fast.reply, "fast");
  release();
  await slow;
});
```

Update existing router assertions to `await route(...)`. Add a loader fixture whose `handle` is declared `async` and assert it loads.

- [ ] **Step 2: Run core tests and verify async plugins are rejected or mis-normalized**

Run:

```powershell
node --test plan/tests/plugin-loader.test.mjs plan/tests/plugin-router.test.mjs plan/tests/router-concurrency.test.mjs
```

Expected: FAIL on the async fixture and concurrency contract.

- [ ] **Step 3: Make router invocation and help rendering promise-aware**

Change `invokePlugin`, `renderPluginHelp`, and the returned route handler to `async`; normalize only after `await`:

```js
async function invokePlugin(plugin, text, context) {
  try {
    const value = await plugin.module.handle(text, context);
    return normalizePluginResult(value, plugin.manifest.id);
  } catch (error) {
    return pluginError(plugin.manifest.id, error);
  }
}
```

Await exact-command handling, natural match results, main help, and plugin help. Preserve `null` for unmatched messages and preserve the local plugin error reply.

Create one metrics object per routed message. `createMashiroBotContext` exposes a request-scoped process wrapper whose `onComplete` adds each child-process duration to that object. The router writes one completion log record in `finally`; plugins never update the log file directly.

- [ ] **Step 4: Relax only the loader’s async-function prohibition**

Keep required export and manifest checks; remove the `AsyncFunction` rejection. Do not weaken path traversal, duplicate command, menu index, or disabled-plugin checks.

- [ ] **Step 5: Make the exported core entry async and repair the WeChat call site**

`handleMashiroBotMessage` returns the route Promise. Update the repair script’s canonical `process-message.js` transformation to require:

```js
const fastRoutineResult = await handleFastRoutineCommand(rawBody, {
  accountId: deps.accountId,
  conversationId: full.from_user_id ?? ctx.To ?? "",
  now: new Date(),
});
```

The repair test must reject a call site without `await`, preserve unknown layouts, and restore both files on validation failure.

- [ ] **Step 6: Queue structured log writes without blocking routing**

Replace synchronous append with a serial Promise queue using `node:fs/promises`. Export `appendMashiroLog(record)` and `flushMashiroLogs()`. A write failure is caught and cannot reject plugin loading or message handling. Add tests that flush before reading the log.

- [ ] **Step 7: Run core, adapter, and full non-financial tests**

Run:

```powershell
node --test plan/tests/plugin-loader.test.mjs plan/tests/plugin-router.test.mjs plan/tests/router-concurrency.test.mjs
pwsh.exe -NoProfile -File plan/tests/test_adapter_repair.ps1
$tests = @(rg --files plan -g '*.test.mjs' -g '!**/mashirobot-plugin-financial-report/**')
node --test @tests
```

Expected: PASS. Any direct call to an async migrated plugin must now be awaited in its test.

- [ ] **Step 8: Record the checkpoint**

Commit the core, adapter, logging, and tests if Git is valid; otherwise append their hashes under `Task 3`.

---

### Task 4: Add atomic content caching and migrate help rendering

**Files:**
- Create: `plan/core/cache/content-cache.mjs`
- Create: `plan/tests/content-cache.test.mjs`
- Modify: `plan/core/menu/help-service.mjs`
- Modify: `plan/tests/help-service.test.mjs`

**Interfaces:**
- Produces: `createContentCache({ root, namespace, maxEntries, maxBytes, now })`.
- Produces: `cache.getOrCreate({ keyPayload, extension, create }) -> Promise<string[]>` with in-process single-flight deduplication.
- Produces: `cache.copyForUse(paths, { targetRoot }) -> string[]`, which creates unique outbound copies without exposing cache originals to OpenClaw deletion.
- Consumes: `runLocalProcess()` from Task 2.

- [ ] **Step 1: Write failing cache tests**

Assert stable object-key ordering, atomic publication, one creator call for concurrent identical requests, no reuse of a missing/partial entry, and eviction by age/size:

```js
test("deduplicates concurrent creation for one content hash", async () => {
  let calls = 0;
  const create = async ({ outputPaths }) => {
    calls += 1;
    await writeFile(outputPaths[0], "complete");
  };
  const [left, right] = await Promise.all([
    cache.getOrCreate({ keyPayload: { b: 2, a: 1 }, extension: ".png", create }),
    cache.getOrCreate({ keyPayload: { a: 1, b: 2 }, extension: ".png", create }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(left, right);
});
```

- [ ] **Step 2: Run tests and verify module-not-found failure**

Run `node --test plan/tests/content-cache.test.mjs`.

- [ ] **Step 3: Implement stable hashing, temporary staging, and eviction**

Use SHA-256 over stable JSON plus a caller-supplied version. Create into a unique staging directory, verify every expected output is a regular nonempty file, rename into the cache namespace, and only then expose paths. Keep a `Map<hash, Promise>` for single-flight work and remove it in `finally`.

`copyForUse` creates `targetRoot`, copies each cached file to a random UUID filename with the same extension, and returns only the copied paths.

- [ ] **Step 4: Convert help rendering to async cache calls**

Replace `spawnSync` with `runLocalProcess`. Keep `prepareOutboundCopies` synchronous because it only copies small local files, but call it after the awaited cache result. Preserve the text fallback on render failure.

The picture help service calls `context.runLocalProcess ?? runLocalProcess` so renderer time is included in the current request metrics.

- [ ] **Step 5: Update and run help tests**

Convert help service tests to await service methods. Add a test that two concurrent identical help requests start one renderer and return distinct outbound copies backed by one cached original.

Run:

```powershell
node --test plan/tests/content-cache.test.mjs plan/tests/help-service.test.mjs plan/tests/plugin-router.test.mjs
```

- [ ] **Step 6: Record the checkpoint**

Commit or hash-record the cache, help service, and tests.

---

### Task 5: Make status collection resilient, cached, and single-render-pass

**Files:**
- Modify: `plan/plugin/mashirobot-plugin-status/core/collector.mjs`
- Create: `plan/plugin/mashirobot-plugin-status/core/status-cache.mjs`
- Modify: `plan/plugin/mashirobot-plugin-status/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-status/render/status-card.py`
- Modify: `plan/plugin/mashirobot-plugin-status/powershell/status-collector.ps1`
- Modify: `plan/plugin/mashirobot-plugin-status/tests/collector.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-status/tests/plugin.test.mjs`
- Create: `plan/plugin/mashirobot-plugin-status/tests/cache.test.mjs`

**Interfaces:**
- Produces: `collectStatus(options) -> Promise<NormalizedStatus>`.
- Produces: `createStatusCache({ root, statusTtlMs, hardwareTtlMs, now })` with `read(kind)` and `write(kind, data)`.
- Renderer accepts legacy `--output/--kind` and new `--outputs-base64 <base64-json-map>`.
- Consumes: `runLocalProcess()` and `createContentCache()`.

- [ ] **Step 1: Add failing tests for async collection, cache freshness, partial probes, and one render process**

```js
test("status request renders status and temperature in one child process", async () => {
  let starts = 0;
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const fakePythonRenderer = async (args) => {
    const encoded = args[args.indexOf("--outputs-base64") + 1];
    const outputs = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    await Promise.all(Object.values(outputs).map((target) => writeFile(target, onePixelPng)));
  };
  const result = await handle("状态", {
    statusData: fixtureData,
    runLocalProcess: async ({ args }) => {
      starts += 1;
      await fakePythonRenderer(args);
      return { exitCode: 0, stdout: "", stderr: "", elapsedMs: 1 };
    },
    tempRoot,
  });
  assert.equal(starts, 1);
  assert.equal(result.mediaPaths.length, 2);
});
```

Add tests that a status cache expires after its short TTL, hardware remains fresh for its long TTL, stale data is labeled with `capturedAt`, and one failed network probe remains in normalized output without failing the command.

- [ ] **Step 2: Run status tests and verify expected failures**

Run:

```powershell
$files = @(rg --files plan/plugin/mashirobot-plugin-status/tests -g '*.test.mjs')
node --test @files
```

- [ ] **Step 3: Convert the collector to `runLocalProcess`**

Pass PowerShell arguments unchanged, request JSON document output, and translate `PROCESS_TIMEOUT` to the existing Chinese timeout message. Keep normalization pure and separately tested. `handle` passes `context.runLocalProcess` into the collector and renderer; direct tests can inject the same signature.

- [ ] **Step 4: Implement atomic status/hardware cache files**

Write `{ capturedAt, writtenAt, data }` to a sibling temporary file and rename. `read(kind)` returns `{ fresh, ageMs, data }` and rejects malformed or future-dated files. Defaults: status TTL `5_000` ms; hardware TTL `86_400_000` ms.

- [ ] **Step 5: Extend the Python renderer for multiple outputs**

Decode an outputs map such as `{"status":"C:/.../status.png","temperature":"C:/.../temperature.png"}` and call the existing card functions in one interpreter process. Retain the old CLI path so direct tools and old tests remain compatible.

- [ ] **Step 6: Parallelize independent PowerShell probes**

Refactor the script into functions that return plain objects. Use PowerShell 7 thread jobs for CPU sampling, temperature collection, and network probes; wait with an explicit deadline and convert a failed job into an error field for only that probe. Keep hardware inventory separate from live status and do not require unavailable sensors.

- [ ] **Step 7: Make `handle` async and implement cache policy**

On a fresh cache hit, skip PowerShell. On a miss, collect and atomically cache. Render requested images through one Python call and content-hash the result. If fresh collection fails but a stale complete cache exists, return it with a visible “采集于 …，实时刷新失败” suffix; otherwise return the existing local failure format.

- [ ] **Step 8: Run status and full non-financial tests**

Run status tests, then the full test command from Task 2. Confirm `rg -n "spawnSync|execFileSync" plan/plugin/mashirobot-plugin-status` returns no message-path occurrence.

- [ ] **Step 9: Record the checkpoint**

Commit or hash-record all status changes.

---

### Task 6: Share the async planner bridge with the language plugin

**Files:**
- Modify: `plan/plugin/mashirobot-plugin-plan/bridge/planner-runner.mjs`
- Modify: `plan/plugin/mashirobot-plugin-language/index.mjs`
- Create: `plan/plugin/mashirobot-plugin-language/tests/plugin.test.mjs`
- Create: `plan/plugin/mashirobot-plugin-language/tests/cache.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/tests/english-skills-route.test.mjs`

**Interfaces:**
- Produces: async methods `runPlanner(args, options)`, `runManagePlan(action, values)`, `runRoutineAction(action, values)`, `generateRecordChart(payload)`, and `generateEnglishSkillsChart(payload)`.
- Consumes: `runLocalProcess()` and `createContentCache()`.
- Language plugin consumes `createPlanRuntime(context)` instead of maintaining a second Python launcher.

- [ ] **Step 1: Add failing language tests independent of plan route tests**

Test all statistic aliases, keyword list/add/remove with a temporary database and keyword file, chart fallback, cache hit, and error redaction:

```js
test("chart failure preserves exact text statistics", async () => {
  const result = await handle("本周英语统计图", fixtureContext({ chartFails: true }));
  assert.match(result.reply, /英语五项学习统计/);
  assert.match(result.reply, /图表生成失败，文字统计仍可用/);
  assert.deepEqual(result.mediaPaths, []);
});
```

- [ ] **Step 2: Run language tests and verify current synchronous implementation fails injected async behavior**

Run:

```powershell
$files = @(rg --files plan/plugin/mashirobot-plugin-language/tests -g '*.test.mjs')
node --test @files
```

- [ ] **Step 3: Convert planner runner methods to async local-process calls**

Use JSON document mode for Python and PowerShell operations that return JSON. Preserve the existing environment variables and timeouts. The runtime resolves its runner as `context.runLocalProcess ?? runLocalProcess`. `removeScheduledTask` remains fire-and-forget only for legacy cleanup and must return a Promise resolving to its launch result.

- [ ] **Step 4: Cache charts by normalized payload and renderer version**

Use the shared content cache. The cache key includes chart command, normalized payload, Python renderer version, and keyword configuration hash. Return cached originals and copy to outbound paths only at send time.

- [ ] **Step 5: Refactor language plugin to use `createPlanRuntime`**

Remove its `execFileSync`, executable resolution, and duplicate JSON parsing. Make `handle` async, await statistics and keyword actions, and retain its existing reply text. After keyword mutation, require the planner result to contain `changed`, `keywords`, and rebuild metadata before claiming historical statistics were recomputed.

- [ ] **Step 6: Run focused tests and verify no duplicate launcher remains**

Run:

```powershell
$files = @(rg --files plan/plugin/mashirobot-plugin-language/tests -g '*.test.mjs')
node --test @files plan/plugin/mashirobot-plugin-plan/tests/english-skills-route.test.mjs
rg -n "execFileSync|spawnSync" plan/plugin/mashirobot-plugin-language plan/plugin/mashirobot-plugin-plan/bridge
```

Expected: tests PASS; search returns no synchronous process launch in these paths.

- [ ] **Step 7: Record the checkpoint**

Commit or hash-record planner bridge, language plugin, and tests.

---

### Task 7: Migrate every plan route and verify partial system failures honestly

**Files:**
- Modify: `plan/plugin/mashirobot-plugin-plan/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/plan.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/record.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/reminder.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/routine.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/sleep.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/wakeup.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/windows/manage-plan.ps1`
- Modify: `plan/plugin/mashirobot-plugin-plan/windows/routine-reminder.ps1`
- Modify: `plan/plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/tests/wakeup-fast-path.test.mjs`
- Create: `plan/plugin/mashirobot-plugin-plan/tests/verified-outcome.test.mjs`

**Interfaces:**
- Produces: `handlePlanPlugin(message, context) -> Promise<RouteResult|null>`.
- Produces: each route handler returning either `null`, a plain result, or a Promise resolved by the dispatcher.
- Produces: PowerShell JSON carrying `operationId`, `verifiedDatabase`, `verifiedTasks`, and `partialFailure` for system-changing actions.
- Consumes: async plan runtime from Task 6.

- [ ] **Step 1: Add failing verified-outcome tests**

Cover database success plus scheduled-task failure, task success plus missing database row, timeout plus late verified success, and unknown state:

```js
test("does not claim a complete plan save when task registration fails", async () => {
  const result = await handlePlan(planText, {
    planRuntime: fakeRuntime({
      runManagePlan: async () => ({
        saved: true,
        verifiedDatabase: true,
        verifiedTasks: false,
        taskError: "registration denied",
      }),
    }),
    now,
  });
  assert.match(result.reply, /计划已保存/);
  assert.match(result.reply, /提醒任务未确认/);
  assert.doesNotMatch(result.reply, /已安排 \d+ 个一次性提醒/);
});
```

- [ ] **Step 2: Run focused tests and verify current routes mishandle Promises**

Run plan tests only; expected failure is Promise-shaped data being formatted synchronously.

- [ ] **Step 3: Make the route dispatcher sequentially await possible results**

```js
for (const invoke of handlers) {
  const result = await invoke();
  if (result) return result;
}
```

Make combined plan/record handling await both sections and preserve their independent error text.

- [ ] **Step 4: Await every planner and PowerShell operation**

Update each route at the exact call sites listed by:

```powershell
rg -n "runPlanner\(|runManagePlan\(|runRoutineAction\(" plan/plugin/mashirobot-plugin-plan/routes
```

No returned Promise may be passed into a formatter.

- [ ] **Step 5: Add explicit partial-success formatting**

For plan save, wakeup, general reminders, and cancellation, format success only from verified flags returned by the runtime. Database-only success says the data is saved but the reminder is not confirmed. Unknown state instructs the user to query status rather than resend immediately.

Update `manage-plan.ps1` and `routine-reminder.ps1` to accept `-OperationId`, propagate it into task metadata/status where available, query the written database record and scheduled task after mutation, and emit exactly one final JSON object. A failed verification sets `partialFailure` and preserves the successful database fact rather than throwing away all evidence.

- [ ] **Step 6: Update all direct plan-handler tests to await results**

Change test callbacks to `async` and await `handle`, `handlePlanPlugin`, and individual async routes. Do not weaken reply assertions.

- [ ] **Step 7: Run plan tests and the full non-financial suite**

Expected: all previous compatibility assertions and new partial-failure assertions PASS.

- [ ] **Step 8: Record the checkpoint**

Commit or hash-record all plan route changes.

---

### Task 8: Remove blocking and false-success paths from game timer, QQ, audit, and block sync

**Files:**
- Modify: `plan/plugin/mashirobot-plugin-game-timer/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/core/scheduler.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/core/qq-session-scheduler.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/block/core/syncer.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/tests/plugin.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/tests/scheduler.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/tests/qq-scheduler.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/block/tests/syncer.test.mjs`
- Create: `plan/plugin/mashirobot-plugin-game-timer/tests/nonblocking.test.mjs`

**Interfaces:**
- Produces: async `scheduler.schedule`, `scheduler.remove`, `qqScheduler.status`, `preflight`, `begin`, `recover`, and `blockSyncer.apply`.
- `qqScheduler.begin(session, { signal })` resolves only on a fresh status file matching `session.id` and all playing invariants.
- Consumes: `runLocalProcess()`.

- [ ] **Step 1: Add the failing no-QQ-call regression test for “加入游戏”**

```js
test("adding a game never queries QQ status", async () => {
  let qqCalls = 0;
  const context = fixtureContext({
    qqSessionScheduler: {
      status: async () => { qqCalls += 1; throw new Error("must not run"); },
    },
  });
  const result = await handle(`加入游戏\n${context.executablePath}`, context);
  assert.match(result.reply, /已加入游戏/);
  assert.equal(qqCalls, 0);
});
```

Assert the audit manifest preserves existing QQ targets when adding a game and only replaces game-derived targets.

- [ ] **Step 2: Add failing async polling, stale-state, idempotency, and rollback tests**

Use fake timers/status reads to prove that another Promise resolves while `begin` waits; reject a status with the wrong session ID, old mtime, missing desktop process, or inactive authorization; assert a failed launch does not increment daily cooldown count and clears preparing state.

- [ ] **Step 3: Run game tests and capture expected failures**

Run all game-timer `.test.mjs` files. The add-game regression should expose the current QQ status call; nonblocking test should expose `Atomics.wait`.

- [ ] **Step 4: Convert schedulers and block syncer to `runLocalProcess`**

Use last-JSON-line mode only for existing scripts that intentionally emit diagnostic lines before JSON. Resolve the runner from the request context and pass it into scheduler constructors. `schtasks.exe /Run` is awaited only until launch completes; authoritative completion comes from its operation-specific state file or database record.

- [ ] **Step 5: Replace QQ busy waiting with cancellable async polling**

Use an injected `delay(ms, signal)` Promise, a monotonic deadline, and `fs.promises.stat/readFile`. Accept only a status whose `sessionId` matches, file mtime is after the begin operation, `phase === "playing"`, `authorizationActive`, `qqInstalled`, and `interactiveProcessActive` are true. On timeout, throw `QQ_START_UNVERIFIED` with the last bounded status summary.

- [ ] **Step 6: Separate game audit target refresh from QQ discovery**

Change `refreshAuditTargets` to merge current persisted QQ targets with newly computed game targets. “加入游戏” and priority marking must never call `qqScheduler.status()`. QQ paths are refreshed only during a verified QQ preflight/begin or by the resident audit worker.

- [ ] **Step 7: Make game plugin handling async and preserve fast local routes**

Declare `handle` async, but keep `查看游戏`, `查看游戏计时`, audit summaries, and priority changes free of child-process calls. Await scheduling and QQ operations. On failure, await safe recovery, mark the session/task failed once, and report both primary and recovery errors without claiming success.

- [ ] **Step 8: Run game tests and enforce search gates**

Run:

```powershell
$files = @(
  rg --files plan/plugin/mashirobot-plugin-game-timer/tests plan/plugin/mashirobot-plugin-game-timer/block/tests plan/plugin/mashirobot-plugin-game-timer/audit/tests -g '*.test.mjs'
)
node --test @files
rg -n "Atomics\.wait|execFileSync|spawnSync" `
  plan/plugin/mashirobot-plugin-game-timer/index.mjs `
  plan/plugin/mashirobot-plugin-game-timer/core `
  plan/plugin/mashirobot-plugin-game-timer/block/core
```

Expected: tests PASS; search returns no message-path blocking call.

- [ ] **Step 9: Record the checkpoint**

Commit or hash-record game-timer changes.

---

### Task 9: Reuse loot stores safely and harden health reporting

**Files:**
- Modify: `plan/plugin/mashirobot-plugin-loot/core/store.mjs`
- Modify: `plan/plugin/mashirobot-plugin-loot/tests/store.test.mjs`
- Modify: `plan/plugin/mashirobot-plugin-loot/core/worker-cli.mjs`
- Modify: `plan/core/health/check-mashirobot.ps1`
- Modify: `plan/plugin/mashirobot-plugin-plan/health.mjs`
- Create: `plan/tests/health-contract.test.mjs`

**Interfaces:**
- Produces: `createLootStore(sqlitePath, { databaseFactory } = {})` returning a cached instance per normalized path.
- Produces: `closeLootStore(sqlitePath)` and `closeAllLootStores()` for tests and process shutdown.
- Produces: health entries with `{ ok, level, evidence, checkedAt }`, where `level` is `file`, `registered`, `heartbeat`, or `verified`.

- [ ] **Step 1: Add failing store-reuse and recovery tests**

```js
test("reuses one initialized connection for the same database", () => {
  const first = createLootStore(sqlitePath);
  const second = createLootStore(path.resolve(sqlitePath));
  assert.equal(first, second);
  first.save("2026-09-16", "one", now);
  assert.equal(second.get("2026-09-16").content, "one");
});
```

Also close the instance, call `createLootStore` again, and assert a new usable instance is returned. Simulate `SQLITE_BUSY` and assert a bounded Chinese failure rather than an unbounded retry.

- [ ] **Step 2: Implement connection registry and one-time schema initialization**

Use a module-level Map keyed by `path.resolve(sqlitePath).toLocaleLowerCase("en")`. Initialize WAL, busy timeout, and schema once. Remove a store from the map when closed. The worker CLI must close its store in `finally` so a short-lived worker exits cleanly.

`databaseFactory` defaults to `(target) => new DatabaseSync(target)` and exists only to inject deterministic busy/closed behavior in tests. Production callers omit the second argument.

- [ ] **Step 3: Add failing health-level tests**

Assert that a registered task without a fresh status file is not `verified`, an old heartbeat is unhealthy, a current workspace adapter import is verified, and plugin health Promises are awaited.

- [ ] **Step 4: Update health checks to distinguish evidence levels**

In Node and PowerShell, report file presence, task registration, heartbeat freshness, and verified business outcome separately. Await async plugin health functions in the Node snippet:

```js
const healthEntries = await Promise.all(
  registry.plugins.map(async (entry) => [entry.manifest.id, await entry.module.healthCheck()]),
);
```

Keep the excluded financial plugin out of new assertions and edits; discovery may list it, but the optimization health contract only asserts the five in-scope plugins.

- [ ] **Step 5: Run loot and health tests**

Run:

```powershell
$files = @(rg --files plan/plugin/mashirobot-plugin-loot/tests -g '*.test.mjs')
node --test @files plan/tests/health-contract.test.mjs
pwsh.exe -NoProfile -File plan/core/health/check-mashirobot.ps1
```

For live health, document environmental failures separately from code-test failures; do not rewrite tests to accept an unhealthy runtime.

- [ ] **Step 6: Record the checkpoint**

Commit or hash-record loot and health changes.

---

### Task 10: Run end-to-end verification, deploy the adapter, and compare performance

**Files:**
- Modify only if tests expose a defect: files already listed in Tasks 2–9
- Create: `plan/docs/superpowers/plans/2026-09-16-project-performance-robustness-results.md`
- Update: `plan/docs/superpowers/plans/2026-09-16-project-performance-robustness.checkpoints.txt`

**Interfaces:**
- Consumes all previous task interfaces.
- Produces the final evidence report, after-performance JSON, runtime health evidence, and exact excluded-plugin comparison.

- [ ] **Step 1: Run static blocking-call gates**

Run:

```powershell
rg -n --glob '!**/mashirobot-plugin-financial-report/**' `
  "execFileSync|spawnSync|Atomics\.wait" `
  plan/core plan/plugin
```

Classify every remaining result. It may remain only in offline installers/tests or a documented non-message-path maintenance script. Any result reachable from router `handle` must be removed before proceeding.

- [ ] **Step 2: Run the complete non-financial Node and PowerShell suites**

```powershell
$tests = @(rg --files plan -g '*.test.mjs' -g '!**/mashirobot-plugin-financial-report/**')
node --test @tests
pwsh.exe -NoProfile -File plan/tests/test_adapter_repair.ps1
```

Expected: zero failures and no new skips. Record test count, duration, skipped reasons, and the exact command in the result document.

- [ ] **Step 3: Run fault-injection and event-loop responsiveness checks**

Run focused runner, concurrency, verified-outcome, status-cache, and QQ nonblocking tests three times. Fail the task if a timeout leaves a child process, state lock, staging directory, or preparing database row.

- [ ] **Step 4: Generate after-performance data and compare budgets**

```powershell
$guardRoot = Join-Path $env:LOCALAPPDATA 'MashiroBot\integrity'
node plan/tools/benchmark-local-routes.mjs --output (Join-Path $guardRoot 'performance-after.json')
```

Write before/after medians, maxima, and external starts into the result document. Required gates: pure local routes under 100 ms in the test environment; “加入游戏” under 200 ms and zero QQ/PowerShell starts; cached help/statistics/hardware rendering starts zero Python processes.

- [ ] **Step 5: Repair and verify the installed WeChat adapter**

First run `repair-openclaw-adapter.ps1 -WhatIfReport`. Confirm only the known adapter and process-message call site are targeted. Then run the repair script normally, execute its syntax validation, restart the existing gateway through the project’s wrapper/task, and verify gateway health. Do not create a second gateway process.

- [ ] **Step 6: Verify safe representative commands through the actual runtime entry**

Use read-only or temporary-data commands: help, plan query, English statistics, status, `查看游戏`, `查看游戏计时`, and a loot record against a temporary SQLite path. Confirm request IDs and plugin durations appear in logs. Do not start QQ, close a game, move an executable, or create a real reminder without separate user authorization.

- [ ] **Step 7: Compare the excluded-plugin snapshot**

```powershell
$guardRoot = Join-Path $env:LOCALAPPDATA 'MashiroBot\integrity'
pwsh.exe -NoProfile -File plan/tools/plugin-integrity.ps1 -Mode Compare `
  -PluginPath plan/plugin/mashirobot-plugin-financial-report `
  -SnapshotPath (Join-Path $guardRoot 'financial-report-before.json')
```

Expected: exit code `0` and an empty difference set. Any mismatch blocks completion and must be investigated without overwriting the baseline.

- [ ] **Step 8: Write the final evidence report**

The result document must include: changed files by task, full test output summary, runtime version/import evidence, before/after performance table, false-success fault tests, live checks not performed and why, remaining limitations, and the financial-plugin integrity result.

- [ ] **Step 9: Record the final checkpoint**

If Git is valid, commit the results and all remaining reviewed changes. Otherwise append hashes for every changed non-financial file and both plan/result documents to the checkpoint file. Do not claim a Git commit exists.
