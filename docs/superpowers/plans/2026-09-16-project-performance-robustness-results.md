# MashiroBot project performance and robustness results

Date: 2026-09-16 (Asia/Shanghai)

## Outcome

The non-financial MashiroBot paths were converted to asynchronous local execution, repeated rendering and database setup were reduced, mutation replies now distinguish verified and uncertain outcomes, QQ preparation no longer blocks the event loop, and installed OpenClaw routing was repaired and restarted successfully.

The excluded `mashirobot-plugin-financial-report` directory was not changed. Its final integrity comparison returned `integrity: unchanged`.

## Changes by task

- Task 1: captured the financial-plugin integrity baseline and route performance baseline.
- Task 2: added the bounded asynchronous local-process runner and its timeout, abort, byte-limit, cleanup, and no-shell tests.
- Task 3: made plugin loading/routing asynchronous, propagated request metrics, contained logging failures, and updated the OpenClaw adapter templates.
- Task 4: added hash-addressed content caching, cross-instance publication locking, use leases, bounded eviction, cached help rendering, and concurrency/fault tests.
- Task 5: made status collection asynchronous, added status/hardware data caches, and rendered each response in one child process.
- Task 6: moved planner and language bridges to the shared asynchronous runner and cached English chart output.
- Task 7: made plan routes asynchronous, added operation IDs and verified mutation outcomes, and separated unknown/partial outcomes from success.
- Task 8: made game, block, audit, and QQ paths nonblocking; removed the unrelated QQ query from `加入游戏`; added fresh, session-bound QQ readiness verification and cleanup on preparation failure.
- Task 9: cached one initialized loot store per normalized SQLite path, added explicit close APIs and bounded Chinese `SQLITE_BUSY` errors, and introduced health evidence levels (`file`, `registered`, `heartbeat`, `verified`).

Exact per-task file hashes are recorded in `2026-09-16-project-performance-robustness.checkpoints.txt`.

## Unified verification

Commands:

```powershell
rg -n --glob '!**/mashirobot-plugin-financial-report/**' "execFileSync|spawnSync|Atomics\.wait" plan/core plan/plugin
$tests = @(rg --files plan -g '*.test.mjs' -g '!**/mashirobot-plugin-financial-report/**')
node --test @tests
pwsh.exe -NoProfile -File plan/tests/test_adapter_repair.ps1
```

Results:

- Blocking-call gate: no matches in the non-financial core/plugin message paths.
- Node tests: 212 total, 210 passed, 0 failed, 2 skipped, duration 10.33 seconds.
- The two skips are the pre-existing compatibility-oracle cases whose installed router is the canonical adapter rather than an independent old implementation.
- PowerShell adapter tests: repair, rollback, idempotence, validation failure restoration, and wrapper tests passed.
- Fault paths covered in the unified run include child timeout/error races, abandoned cache locks, stale heartbeats, partial plan mutation outcomes, failed scheduler cleanup, and failed QQ preparation recovery.
- In accordance with the request to avoid excessive testing, the complete suite was run once rather than repeating the same focused groups three times.

## Performance comparison

Five samples per route; times are milliseconds.

| Route | Before median / max | After median / max | External starts before → after |
|---|---:|---:|---:|
| 查看游戏 | 0.145 / 0.879 | 0.155 / 1.098 | 0 → 0 |
| 查看游戏计时 | 2.878 / 9.234 | 3.587 / 9.800 | 0 → 0 |
| 爽点保存 | 4.412 / 8.930 | 0.492 / 7.402 | 0 → 0 |
| 帮助图片（缓存命中） | 0.899 / 1.033 | 2.712 / 3.101 | 0 → 0 |
| 帮助图片（缓存未命中） | 206.700 / 218.215 | 230.221 / 235.491 | 5 → 5 |
| 加入游戏 | 2.155 / 3.602 | 2.375 / 3.181 | 5 → 0 |

All pure local routes stayed below the 100 ms budget. `加入游戏` stayed far below 200 ms and no longer starts QQ or PowerShell. Cached help starts no renderer process. The unified cache tests also verified that repeated English-chart and status/hardware requests reuse published output rather than launching duplicate renderers.

The uncached help route remains intentionally dominated by Python image rendering. Small sub-millisecond changes in local query routes and the roughly 24 ms uncached-render variation are benchmark noise rather than regressions in the message path.

Raw reports:

- `%LOCALAPPDATA%\MashiroBot\integrity\performance-before.json`
- `%LOCALAPPDATA%\MashiroBot\integrity\performance-after.json`

## Installed runtime verification

The adapter dry-run identified only the known OpenClaw package targets:

- `dist/src/messaging/fast-routine.js`: already canonical.
- `dist/src/messaging/process-message.js`: known synchronous call site, then repaired to canonical.

The repair script created timestamped backups and passed syntax validation. `openclaw gateway restart` restarted the existing scheduled service; `openclaw gateway health` returned `OK (34ms)` and `openclaw-weixin: configured`. Process inspection found one gateway listener process, not a duplicate.

The post-restart health script returned `ok: true` with no failures. It verified plugin discovery, SQLite integrity, canonical installed adapter, current QQ heartbeat, task/cron references, source references, and temporary help rendering.

The installed `fast-routine.js` entry was exercised with safe commands. Successful routes were: help, today plan query, weekly English statistics image, status, `查看游戏`, `查看游戏计时`, and a loot record against a temporary SQLite database. Request IDs and plugin timings were written to the MashiroBot log. The literal text `查询计划` did not match by itself; the supported `今天计划` phrase returned command `查询计划` successfully.

## Deliberately unperformed live actions

No QQ session was started, no game process was closed, no executable was moved, and no real reminder/task was created. These actions were unnecessary for the safe runtime verification and could disrupt the user's current state.

## Remaining limitations

- The first uncached status collection still depends on external Windows probes and took about 12.5 seconds in the live smoke check; subsequent data/image cache behavior is covered by tests.
- Image cache hits add a few milliseconds for validation and creation of a unique outbound copy. This preserves cache integrity and remains well below the local-route budget.
- Health levels describe the strength of evidence; a registered task alone is intentionally not labeled `verified` without a fresh successful status or heartbeat.
