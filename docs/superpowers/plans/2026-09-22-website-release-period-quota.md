# Website Release Period Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce independent per-website temporary-release quotas of 20 minutes from 00:00–12:00, 30 minutes from 12:00–18:00, and 30 minutes from 18:00–24:00 in Shanghai time.

**Architecture:** Add an append-only release-interval ledger beside the current `block_releases` state. A focused quota module splits intervals at Shanghai period boundaries, merges overlap, and validates a proposed reset-from-now interval; storage updates the ledger and current release atomically. The plugin rejects an over-quota request before system synchronization and reports remaining quota.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, `node:test`, PowerShell installer/runtime copy.

**Spec:** `docs/superpowers/specs/2026-09-22-website-release-period-quota-design.md`

## Global Constraints

- All quota boundaries use `Asia/Shanghai`.
- Each website has independent 20/30/30-minute quotas for 00:00–12:00, 12:00–18:00, and 18:00–24:00.
- Count actual union duration; do not double-count overlapping release time.
- Split cross-boundary requests across the periods they touch.
- Reject the complete request if any touched period lacks quota; never shorten it automatically.
- Preserve reset-from-now semantics, daily default selection, automatic restore, and immediate restore.
- Do not change QQ sessions, game restrictions, or the Hosts/browser/Clash synchronization policy.

---

### Task 1: Pure Shanghai-time quota calculation

**Files:**
- Create: `plugin/mashirobot-plugin-game-timer/block/core/release-quota.mjs`
- Create: `plugin/mashirobot-plugin-game-timer/block/tests/release-quota.test.mjs`

**Interfaces:**
- Produces: `evaluateReleaseQuota({ intervals, proposedStart, proposedEnd })` returning `{ allowed, periods }` where each period has `key`, `label`, `limitMinutes`, `usedMinutes`, `addedMinutes`, and `remainingMinutes`.
- Produces: `quotaPeriodsTouched(start, end)` for deterministic Shanghai boundary splitting.

- [ ] **Step 1: Write failing tests for all three periods and independent interval union**

```js
assert.equal(evaluateReleaseQuota({ intervals: [], proposedStart: at("2026-09-22 09:00"), proposedEnd: at("2026-09-22 09:20") }).allowed, true);
assert.equal(evaluateReleaseQuota({ intervals: [{ startAt: at("2026-09-22 09:00"), endAt: at("2026-09-22 09:10") }], proposedStart: at("2026-09-22 09:05"), proposedEnd: at("2026-09-22 09:15") }).periods[0].usedMinutes, 10);
```

- [ ] **Step 2: Run the focused test and verify it fails because the module is absent**

Run: `node --test plugin/mashirobot-plugin-game-timer/block/tests/release-quota.test.mjs`

- [ ] **Step 3: Implement boundary splitting, overlap merging, and per-period limits**

Use UTC instants internally and derive Shanghai midnight/12:00/18:00 boundaries without relying on the host time zone. Merge sorted clipped intervals before calculating milliseconds, and keep exact milliseconds for validation while rounding only reply display values.

- [ ] **Step 4: Add tests for 11:50–12:10, 17:50–18:10, 23:50–00:10, and insufficient quota**

Expected: each cross-boundary request charges ten minutes to each touched period; a request touching one exhausted period has `allowed === false`.

- [ ] **Step 5: Run the focused test and commit**

Run: `node --test plugin/mashirobot-plugin-game-timer/block/tests/release-quota.test.mjs`

Commit: `feat: calculate website release period quotas`

### Task 2: Transactional release history and quota enforcement

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/core/storage.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/tests/storage.test.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/block-db-v1.mjs`

**Interfaces:**
- Produces: `store.tryRelease({ targetKey, displayName, expiresAt }, now)` returning `{ allowed, release, quota }`.
- Changes: `store.restoreRelease(targetKey, now)` truncates the active ledger interval before deleting current state.
- Produces: `store.getReleaseQuota(targetKey, start, end, now)` for replies and tests.

- [ ] **Step 1: Write failing storage tests**

Cover an accepted first release, a rejected over-limit release with unchanged `block_releases`, an overlapping reset charged by actual union time, early restore truncation, separate websites, and deletion cleanup.

- [ ] **Step 2: Run storage tests and verify the new methods are missing**

Run: `node --test plugin/mashirobot-plugin-game-timer/block/tests/storage.test.mjs`

- [ ] **Step 3: Add the ledger schema**

```sql
CREATE TABLE IF NOT EXISTS block_release_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_block_release_intervals_target_time
ON block_release_intervals(target_key,start_at,end_at);
```

- [ ] **Step 4: Implement `tryRelease` as one `BEGIN IMMEDIATE` transaction**

Read the current release, model it as ending at `now`, evaluate historical intervals plus the proposed reset interval, roll back and return quota details when disallowed, or truncate the current ledger row, insert the accepted interval, and upsert `block_releases` before commit.

- [ ] **Step 5: Make restore, rule deletion, and expiry cleanup ledger-aware**

Immediate restore truncates future interval ends to `now`. Rule deletion removes ledger rows for the target. Cleanup removes ledger rows whose end is older than eight Shanghai dates without deleting any interval needed for a current-day calculation. Mirror schema compatibility in `block-db-v1.mjs`.

- [ ] **Step 6: Run storage and worker-facing tests and commit**

Run: `node --test plugin/mashirobot-plugin-game-timer/block/tests/storage.test.mjs plugin/mashirobot-plugin-game-timer/block/tests/worker.test.mjs`

Commit: `feat: persist and enforce website release quotas`

### Task 3: Command integration and user-visible quota replies

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/index.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/block/tests/plugin.test.mjs`

**Interfaces:**
- Consumes: `store.tryRelease(...)` and its `{ allowed, release, quota }` result.
- Produces: release replies containing relevant remaining quota; rejection replies identify each insufficient period and its remaining minutes.

- [ ] **Step 1: Write failing command tests**

Test success replies, morning exhaustion, rejection without syncer invocation, cross-period rejection, default-site behavior, repeated reset, immediate restore, and independent sites.

- [ ] **Step 2: Run plugin tests and verify failures**

Run: `node --test plugin/mashirobot-plugin-game-timer/block/tests/plugin.test.mjs`

- [ ] **Step 3: Replace direct `store.release` with `store.tryRelease`**

When `allowed` is false, return a normal `临时解除网站` response before invoking `syncer.apply`. When allowed, retain the existing expiry/default-site lines and append a compact remaining-quota line for the touched period or periods.

- [ ] **Step 4: Pass `now` into immediate restore and update help text**

State that each website independently has 上午20分钟、下午30分钟、晚上30分钟 and that requests exceeding remaining quota are rejected.

- [ ] **Step 5: Run block module tests and commit**

Run: `node --test plugin/mashirobot-plugin-game-timer/block/tests/*.test.mjs`

Commit: `feat: enforce quotas in website release commands`

### Task 4: Deploy runtime copy and verify regression safety

**Files:**
- Modify only through the existing installer-generated runtime under `%LOCALAPPDATA%\MashiroBot`.
- Test: repository-wide game-timer and route suites.

**Interfaces:**
- Consumes: the tested source plugin and existing installer entrypoint.
- Produces: installed runtime matching source hashes for changed block-module files.

- [ ] **Step 1: Identify and run the existing game-timer/block installer**

Use the repository installer rather than manually copying individual source files. Preserve the machine-specific SQLite path and existing scheduled tasks.

- [ ] **Step 2: Run full relevant automated tests**

Run the block tests, all `mashirobot-plugin-game-timer` Node tests, and the plan route compatibility suite. All must pass with no new failures.

- [ ] **Step 3: Verify installed runtime statically**

Compare hashes of the changed source files with their installed runtime counterparts and verify the scheduled block worker remains registered and healthy. Do not trigger a real website release during verification.

- [ ] **Step 4: Review the final diff and commit deployment/source changes**

Confirm unrelated pre-existing modifications remain unstaged. Commit only files belonging to this feature.

