# QQ SYSTEM Encrypted Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plaintext renamed QQ executable vault with a SYSTEM-only encrypted container, and add a once-per-Sunday `周末玩QQ4h` session that runs for the full four hours even across Monday midnight.

**Architecture:** Keep the existing QQ session state machine and SYSTEM reconcile task, but add a focused PowerShell container helper for AES-GCM plus SYSTEM-user DPAPI key wrapping. Extend the SQLite model with an explicit Sunday policy and consumption marker, sanitize all user-visible status, and route manual releases through fixed SYSTEM tasks instead of copying a recorded vault path.

**Tech Stack:** Node.js ESM, `node:sqlite`, PowerShell 7, .NET `AesGcm` and `ProtectedData`, Windows Task Scheduler, Pester-style PowerShell fixture scripts, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-12-qq-system-encrypted-vault-design.md`

## Global Constraints

- Preserve the normal daily QQ window `[12:00, 22:00)` in `Asia/Shanghai`; only `周末玩QQ4h` bypasses it.
- Preserve the fixed 60-minute cooldown after every successfully started normal or Sunday session.
- `周末玩QQ4h` is accepted only while Shanghai local time is Sunday, lasts exactly 240 minutes, may cross Monday and 22:00, and succeeds at most once per Shanghai-local Sunday date.
- A technical failure before verified interactive launch does not consume the Sunday allowance; early exit, normal completion, and resume do not restore it.
- Do not place data in Windows-owned directories or disguise a payload as a loadable DLL.
- The protected payload must not be plaintext PE data; renaming it to `QQ.exe` must not create a runnable executable.
- Never delete the only verified copy. Hash, AES-GCM authentication, ordinary-file checks, and Tencent signature validation gate destructive steps.
- Do not expose `vaultPath`, the encrypted-container root, file name, wrapped key, nonce, or tag through normal status or `last-status.json`.
- Preserve unrelated dirty-worktree changes. Stage and commit only files listed in each task.

---

### Task 1: Add the Sunday four-hour policy to the model and storage

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-model.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-storage.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-db-v1.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs`

**Interfaces:**
- Produces: `QQ_WINDOW_POLICIES = { DAILY: "daily", SUNDAY_FOUR_HOURS: "sunday-4h" }`.
- Produces: `buildQqRequest({ now, id, minutes, windowPolicy, specialLocalDate })`.
- Produces: session fields `windowPolicy`, `specialLocalDate`, and `specialConsumedAt`.
- Produces: policy-aware `store.activateAfterInstall(id, confirmedAt, tasks)` plus `store.consumeSundayAllowance(id, consumedAt)`; activation establishes the authorization window, while consumption is recorded only after verified interactive launch.
- Consumes later: parser/plugin and PowerShell DB helper use these exact names.

- [ ] **Step 1: Write failing model and storage tests**

Add tests that construct a special request and prove the once-per-day transaction:

```js
const sunday = buildQqRequest({
  now: "2026-10-11T13:00:00Z",
  id: "sunday-one",
  minutes: 240,
  windowPolicy: "sunday-4h",
  specialLocalDate: "2026-10-11",
});
assert.equal(sunday.playMinutes, 240);
assert.equal(sunday.windowPolicy, "sunday-4h");
assert.throws(() => buildQqRequest({ minutes: 240 }), /minutes/);

const first = store.createPreparing(sunday);
assert.equal(first.created, true);
const active = store.activateAfterInstall("sunday-one", "2026-10-11T13:01:00Z");
assert.equal(active.playEndsAt, "2026-10-11T17:01:00.000Z");
assert.equal(active.cooldownEndsAt, "2026-10-11T18:01:00.000Z");
assert.equal(active.specialConsumedAt, null);
const consumed = store.consumeSundayAllowance("sunday-one", "2026-10-11T13:01:05Z");
assert.equal(consumed.specialConsumedAt, "2026-10-11T13:01:05.000Z");
store.setPhase("sunday-one", "cooldown", null, "2026-10-11T17:01:00Z");
store.setPhase("sunday-one", "ready", null, "2026-10-11T18:01:00Z");
const second = store.createPreparing(buildQqRequest({
  now: "2026-10-11T18:02:00Z", id: "sunday-two", minutes: 240,
  windowPolicy: "sunday-4h", specialLocalDate: "2026-10-11",
}));
assert.equal(second.created, false);
assert.equal(second.reason, "sunday-limit");
```

Also test that a special row activated and then moved to `failed` before `consumeSundayAllowance()` permits a retry, that two stores racing to create the same date yield only one preparing row, and that the unique consumed-date index rejects duplicate successful consumption.

- [ ] **Step 2: Run the focused Node test and verify failure**

Run:

```powershell
node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs
```

Expected: FAIL because 240 minutes, policy fields, and `consumeSundayAllowance` are not implemented.

- [ ] **Step 3: Rebuild the session schema with explicit policy fields**

Make the canonical table constraint accept either a 1–60 minute daily request or an exact 240-minute Sunday request:

```sql
window_policy TEXT NOT NULL DEFAULT 'daily'
  CHECK(window_policy IN ('daily','sunday-4h')),
special_local_date TEXT,
special_consumed_at TEXT,
CHECK(
  (window_policy='daily' AND play_minutes BETWEEN 1 AND 60 AND special_local_date IS NULL)
  OR
  (window_policy='sunday-4h' AND play_minutes=240 AND special_local_date IS NOT NULL)
)
```

When `sqlite_master.sql` lacks `window_policy`, rename the old table, create the new table, copy old rows as `daily`, preserve every existing column, recreate indexes, and drop the old table inside one transaction. Add:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_qq_sunday_consumed_date
ON qq_timed_sessions(special_local_date)
WHERE window_policy='sunday-4h' AND special_consumed_at IS NOT NULL;
```

- [ ] **Step 4: Implement policy-aware requests and atomic consumption**

Use explicit validation rather than treating every 240-minute request as special:

```js
export const QQ_WINDOW_POLICIES = Object.freeze({
  DAILY: "daily",
  SUNDAY_FOUR_HOURS: "sunday-4h",
});

const special = windowPolicy === QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS;
if (special ? minutes !== 240 || !/^\d{4}-\d{2}-\d{2}$/.test(specialLocalDate ?? "")
            : !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) {
  throw new RangeError("minutes do not match the QQ window policy");
}
```

`createPreparing()` must begin an immediate transaction, check both the existing blocking row and an already consumed `special_local_date`, and return `{ created: false, reason: "sunday-limit", session: consumedRow }` for the latter. `activateAfterInstall()` must accept the policy-aware 240-minute row and calculate its end plus 60-minute cooldown without consuming the allowance. `consumeSundayAllowance()` must use one immediate transaction to require `phase='playing'`, set `special_consumed_at`, and rely on the unique index to reject a race.

Keep `activate64` policy-aware and expose the post-launch operation from `qq-session-db-v1.mjs` as `consume-sunday64`.

- [ ] **Step 5: Run storage tests**

Run:

```powershell
node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs
```

Expected: PASS, including schema migration, failed-start retry, cross-midnight timestamps, and one-consumption concurrency.

- [ ] **Step 6: Commit only Task 1 files**

```powershell
git add plugin/mashirobot-plugin-game-timer/core/qq-session-model.mjs plugin/mashirobot-plugin-game-timer/core/qq-session-storage.mjs plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-db-v1.mjs plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs
git commit -m "feat: add once-per-Sunday QQ session policy"
```

### Task 2: Parse and enforce `周末玩QQ4h` in the plugin

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-parser.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/index.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs`
- Test: `plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs`

**Interfaces:**
- Consumes: Task 1 policy constants and `buildQqRequest` fields.
- Produces: `parseQqSessionCommand("周末玩QQ4h")` returns `{ kind: "qq-session", minutes: 240, windowPolicy: "sunday-4h" }`.
- Produces: `evaluateQqSessionWindow(now, command, "Asia/Shanghai")` returns `{ allowed, reason, localDate }`.

- [ ] **Step 1: Add failing parser and plugin tests**

Cover these exact cases:

```js
assert.deepEqual(parseQqSessionCommand("周末玩QQ4h"), {
  kind: "qq-session", minutes: 240, windowPolicy: "sunday-4h",
});
assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T15:59:00Z"), command).allowed, true);
assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T16:00:00Z"), command).reason, "not-sunday");
assert.equal(evaluateQqSessionWindow(new Date("2026-10-10T13:00:00Z"), command).reason, "not-sunday");
```

In plugin tests, assert a Sunday 21:00 Shanghai request replies with an end time of Monday 01:00, a second consumed request returns a once-per-Sunday message without calling preflight, and a scheduler launch failure permits another attempt.

- [ ] **Step 2: Run focused parser/plugin tests and verify failure**

```powershell
node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs
```

Expected: FAIL on the new command and policy result.

- [ ] **Step 3: Implement Shanghai-local policy evaluation**

Use `Intl.DateTimeFormat` with `weekday: "short"` and numeric date fields. Daily commands continue using the existing end-before-22:00 check. The Sunday command is allowed whenever the request instant formats as Sunday and returns the local `YYYY-MM-DD`; it does not inspect its calculated end date.

```js
if (command.windowPolicy === "sunday-4h") {
  return weekday === "Sun"
    ? { allowed: true, reason: null, localDate }
    : { allowed: false, reason: "not-sunday", localDate };
}
```

- [ ] **Step 4: Route the special command through the normal state machine**

In `index.mjs`, build the request with the evaluator's `localDate`. Preserve preflight ordering, existing-session reporting, audit refresh, and rollback. When storage returns `reason === "sunday-limit"`, reply that the Sunday four-hour allowance has already been used. Do not call the manual release script. The SYSTEM worker performs post-launch consumption; the plugin requires `specialConsumedAt` in the returned verified Sunday session before reporting success.

- [ ] **Step 5: Update help text and run plugin tests**

Add concise help stating: `周末玩QQ4h：仅星期日、当天一次、完整4小时、结束后冷却60分钟`.

```powershell
node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit only Task 2 files**

```powershell
git add plugin/mashirobot-plugin-game-timer/core/qq-session-parser.mjs plugin/mashirobot-plugin-game-timer/index.mjs plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs
git commit -m "feat: handle Sunday four-hour QQ command"
```

### Task 3: Build the authenticated encrypted-container helper

**Files:**
- Create: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-executable-container-v2.ps1`
- Create: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-container.ps1`

**Interfaces:**
- Produces: `Write-QQEncryptedContainer -SourcePath -ContainerPath -KeyProtector`.
- Produces: `Expand-QQEncryptedContainer -ContainerPath -DestinationPath -KeyUnprotector`.
- Produces: `Test-QQEncryptedContainer -ContainerPath -ExpectedSha256 -KeyUnprotector`.
- Produces: `Protect-QQContainerKeyForSystem` and `Unprotect-QQContainerKeyForSystem`; production calls require SID `S-1-5-18`.

- [ ] **Step 1: Write the failing container test**

The test must use pass-through key scriptblocks so it runs without SYSTEM, then assert:

```powershell
$sourceBytes=[IO.File]::ReadAllBytes($source)
Write-QQEncryptedContainer -SourcePath $source -ContainerPath $container -KeyProtector { param($key) ,$key }
$containerBytes=[IO.File]::ReadAllBytes($container)
if([Convert]::ToHexString($containerBytes[0..1])-eq'MZ'){throw 'Container retained PE header.'}
Expand-QQEncryptedContainer -ContainerPath $container -DestinationPath $restored -KeyUnprotector { param($wrapped) ,$wrapped }
if((Get-FileHash $restored -Algorithm SHA256).Hash-ne(Get-FileHash $source -Algorithm SHA256).Hash){throw 'Round trip hash mismatch.'}
$containerBytes[$containerBytes.Length-1]=$containerBytes[$containerBytes.Length-1]-bxor 1
[IO.File]::WriteAllBytes($container,$containerBytes)
$rejected=$false;try{Expand-QQEncryptedContainer -ContainerPath $container -DestinationPath "$restored.bad" -KeyUnprotector { param($wrapped) ,$wrapped }}catch{$rejected=$true}
if(-not $rejected){throw 'Tampered container was accepted.'}
```

- [ ] **Step 2: Run the test and verify failure**

```powershell
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-container.ps1
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the binary container format**

Use this exact layout:

```text
8 bytes  ASCII magic "MQVLT002"
4 bytes  little-endian wrapped-key length
12 bytes AES-GCM nonce
16 bytes AES-GCM authentication tag
N bytes  DPAPI-wrapped 32-byte AES key
rest     AES-GCM ciphertext
```

Reject the wrong magic, wrapped-key lengths outside 32–16,384 bytes, truncated data, or authentication failure. Use `[Security.Cryptography.RandomNumberGenerator]::Fill()` and `[Security.Cryptography.AesGcm]::new($key,16)`. Write to a sibling temporary file, flush it, then atomically move it to the requested container path.

Production key wrappers must verify `WindowsIdentity.GetCurrent().User.Value -eq 'S-1-5-18'` and call:

```powershell
[Security.Cryptography.ProtectedData]::Protect(
  $key, [Text.Encoding]::UTF8.GetBytes('MashiroBot.QQ.Container.v2'),
  [Security.Cryptography.DataProtectionScope]::CurrentUser)
```

Use the matching `Unprotect` call for restoration.

- [ ] **Step 4: Run round-trip, tamper, wrong-key, and truncated-container tests**

```powershell
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-container.ps1
```

Expected: PASS with no plaintext `MZ` header and all corrupt variants rejected.

- [ ] **Step 5: Commit Task 3 files**

```powershell
git add plugin/mashirobot-plugin-game-timer/qq/powershell/qq-executable-container-v2.ps1 plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-container.ps1
git commit -m "feat: add SYSTEM encrypted QQ container"
```

### Task 4: Integrate encryption, migration, crash recovery, and status redaction

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/qq-session-storage.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-db-v1.mjs`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`
- Test: `plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs`

**Interfaces:**
- Consumes: Task 3 container functions.
- Produces: vault field `formatVersion`, with `1` for legacy plaintext and `2` for encrypted containers.
- Produces: `Public-ExecutableVault($record)` that never returns `vaultPath`.
- Produces: worker modes `ManualRestore` and `ManualProtect`, both valid only under SYSTEM and explicit authorization state.

- [ ] **Step 1: Add failing storage and worker fixtures**

Extend the vault persistence test with `formatVersion: 2`. In the worker fixture, pass a dedicated `-ExecutableContainerRoot`, protect a fixture EXE, and assert:

```powershell
if($cooldown.installedExecutableVault.PSObject.Properties['vaultPath']){throw 'Public status leaked vaultPath.'}
$record=Db 'installed-vault-active-internal' $null
if($record.formatVersion-ne 2){throw 'Encrypted format was not recorded.'}
$head=[IO.File]::ReadAllBytes([string]$record.vaultPath)[0..1]
if([Convert]::ToHexString($head)-eq'MZ'){throw 'Protected payload is still a PE file.'}
```

Add scenarios for a legacy plaintext record migrating to format 2, container tampering producing `invalid`, occupied destination conflict, and `protecting`/`restoring` crash states converging without losing the last verified copy.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
```

Expected: FAIL on missing format, encryption, migration, or redaction.

- [ ] **Step 3: Add vault schema format and internal/public DB commands**

Add `format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version IN (1,2))` through an idempotent column migration. `installed-vault-active` must return a public record with no path; add `installed-vault-active-internal` for the PowerShell worker only. `setInstalledExecutableVault()` continues to store the internal path and maps `formatVersion`.

- [ ] **Step 4: Replace plaintext move/restore with the container helper**

Dot-source `qq-executable-container-v2.ps1`. For production, assert SYSTEM before encrypt/decrypt. Fixture mode injects pass-through key protectors so tests remain portable.

Protection order:

```text
validate source -> write encrypted temp -> decrypt/verify temp hash and signature
-> persist protecting/formatVersion=2 -> remove source -> persist protected
```

Restoration order:

```text
validate encrypted container -> persist restoring -> decrypt beside destination
-> validate hash/signature -> atomic move to QQ.exe -> persist available -> remove container
```

Migration order is `verify legacy -> create and round-trip verify v2 -> switch DB path/format -> delete legacy`. Do not disclose the generated root through output or logs.

For a Sunday session, the worker calls `activate64`, restores and launches QQ, verifies the interactive process, then calls `consume-sunday64` before returning success. If launch or consumption fails, it revokes authorization, protects any restored executable, moves the session to `failed`, and leaves `special_consumed_at` null unless the verified launch had already been committed.

- [ ] **Step 5: Implement crash recovery and public status**

Implement every state in the spec. Public status uses:

```powershell
function Public-ExecutableVault($record){
 if(-not $record){return $null}
 [ordered]@{
  state=[string]$record.state;formatVersion=[int]$record.formatVersion
  sha256=[string]$record.sha256;signer=[string]$record.signer
  protectedAt=$record.protectedAt;restoredAt=$record.restoredAt
  updatedAt=$record.updatedAt;error=$record.error
 }
}
```

`last-status.json` must serialize only this public shape. Manual modes read the internal record directly and require valid, unexpired `qq-play-authorization.json`; `ManualProtect` requires expired or absent authorization.

- [ ] **Step 6: Run storage, container, and worker tests**

```powershell
node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-container.ps1
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
```

Expected: PASS; status contains no path; legacy plaintext migrates; tampering is rejected.

- [ ] **Step 7: Commit Task 4 files**

```powershell
git add plugin/mashirobot-plugin-game-timer/core/qq-session-storage.mjs plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-db-v1.mjs plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1 plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1 plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs
git commit -m "feat: encrypt and redact the QQ executable vault"
```

### Task 5: Install SYSTEM maintenance tasks and repair manual temporary release

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/deploy-qq-session.ps1`
- Create: `focus-lock/qq-temporary-release.ps1`
- Create: `focus-lock/Restore-QQTempExpiry.ps1`
- Create: `focus-lock/verify-qq-temporary-release.ps1`
- Create: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-install-contract.ps1`

**Interfaces:**
- Consumes: Task 4 `ManualRestore` and `ManualProtect` worker modes.
- Produces: SYSTEM tasks `MashiroBot-QQSession-ManualRestore`, `MashiroBot-QQSession-ManualProtect`, and administrator-only `MashiroBot-QQSession-MaintenanceRestore`.
- Produces: tracked temporary-release source files deployed to the current user and `CodexFocusLock` runtime.

- [ ] **Step 1: Write failing installer contract tests**

Parse installer text or use fixture task builders to assert that all vault-changing task principals are SYSTEM/Highest, the interactive launch task remains current-user/Limited, and only reconcile/manual authorized tasks receive run access for the user. Assert the task arguments contain the worker and container helper deployment root but do not expose the actual generated container path.

- [ ] **Step 2: Run the installer contract and verify failure**

```powershell
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-install-contract.ps1
```

Expected: FAIL because helper deployment and maintenance tasks do not exist.

- [ ] **Step 3: Deploy the helper and create the protected cache root**

`Install-QQSession` copies the helper beside the worker, reuses an existing root from administrator-only config, or generates a non-GUID, non-semantic name from random bytes. It writes the path only to a SYSTEM-readable config file, disables ACL inheritance, grants SYSTEM full control, and removes ordinary user/list access. Never use `Windows`, `System32`, `WinSxS`, or DriverStore.

The regular `config.json` must contain only an opaque reference such as `ContainerConfigPath`; normal status must not echo its content.

- [ ] **Step 4: Register fixed SYSTEM actions**

Use the shared task contract to register fixed worker modes. `ManualRestore` validates a future authorization before decrypting; `ManualProtect` validates expiry before encrypting. Maintenance restore has no time authorization but is not granted run access to the normal user and is used only by elevated uninstall/recovery.

Update `Remove-QQSession` to start maintenance restore, wait for a status file that proves valid signed `QQ.exe` restoration, and only then unregister tasks.

- [ ] **Step 5: Replace direct-copy temporary release scripts**

The tracked `focus-lock/qq-temporary-release.ps1` writes synchronized expiry state and authorization, pauses reconcile, starts `MashiroBot-QQSession-ManualRestore`, and polls for `qqInstalled=true`, a valid signature/hash, cleared barriers, and the future SYSTEM expiry task. It must not read or reference `vaultPath`.

`Restore-QQTempExpiry.ps1` clears authorization first, reapplies FocusLock, starts `MashiroBot-QQSession-ManualProtect`, waits for `state=protected` plus `qqInstalled=false`, then re-enables reconcile. Verification reports task principals, matching expiry, authorization, barriers, QQ process/window status, and protected state without revealing the container path.

- [ ] **Step 6: Run installer and release static/fixture tests**

```powershell
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-install-contract.ps1
rg -n "vaultPath|Copy-Item.*QQ|installedExecutableVault\.vault" focus-lock/qq-temporary-release.ps1 focus-lock/Restore-QQTempExpiry.ps1 focus-lock/verify-qq-temporary-release.ps1
```

Expected: contract PASS; `rg` returns no matches.

- [ ] **Step 7: Commit Task 5 files**

```powershell
git add plugin/mashirobot-plugin-game-timer/qq/powershell/install-qq-session.ps1 plugin/mashirobot-plugin-game-timer/qq/powershell/deploy-qq-session.ps1 focus-lock/qq-temporary-release.ps1 focus-lock/Restore-QQTempExpiry.ps1 focus-lock/verify-qq-temporary-release.ps1 plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-install-contract.ps1
git commit -m "feat: route QQ vault access through SYSTEM tasks"
```

### Task 6: Align worker validation with the Sunday policy

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1`

**Interfaces:**
- Consumes: Task 1 session fields `windowPolicy`, `specialLocalDate`, `specialConsumedAt`.
- Produces: PowerShell `Test-QQSessionWindow` independently rejects forged 240-minute daily requests and accepts trusted Sunday sessions across midnight.

- [ ] **Step 1: Add failing worker boundary tests**

Create DB requests for:

- Sunday 21:00 Shanghai, special policy, 240 minutes: accepted and ends Monday 01:00.
- Sunday 23:59 Shanghai: accepted for the full 240 minutes.
- Monday 00:00 and Saturday 21:00: rejected with barriers intact.
- A forged daily 240-minute row or a special row whose `specialLocalDate` does not match the requested Shanghai date: rejected.
- A consumed Sunday session ending normally: protected with format 2 and 60-minute cooldown.

- [ ] **Step 2: Run the worker test and verify failure**

```powershell
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
```

Expected: FAIL because `Test-QQSessionWindow` still rejects every cross-22:00 session.

- [ ] **Step 3: Implement independent policy validation**

For `daily`, retain the current local start/end window. For `sunday-4h`, require all of:

```powershell
[string]$session.windowPolicy -eq 'sunday-4h'
[int]$session.playMinutes -eq 240
[string]$session.specialLocalDate -eq $requestedShanghaiDate
$requestedShanghaiDayOfWeek -eq [DayOfWeek]::Sunday
```

Do not require the calculated end to remain Sunday or before 22:00. Keep the stored `playEndsAt` authoritative after activation.

- [ ] **Step 4: Run worker and Node tests**

```powershell
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
node --test plugin/mashirobot-plugin-game-timer/tests/qq-session.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-plugin.test.mjs plugin/mashirobot-plugin-game-timer/tests/qq-scheduler.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6 files**

```powershell
git add plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1 plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
git commit -m "feat: enforce Sunday QQ policy in worker"
```

### Task 7: Deploy, migrate the live plaintext vault, and verify the machine

**Files:**
- Runtime: `C:\ProgramData\MashiroBot\mashirobot-plugin-game-timer\qq\workers\qq-session-worker-v1.ps1`
- Runtime: worker-adjacent `qq-executable-container-v2.ps1`
- Runtime: administrator-only container configuration and encrypted cache root
- Runtime: `C:\Users\Mashiroyes\qq-temporary-release.ps1`
- Runtime: `C:\Users\Mashiroyes\verify-qq-temporary-release.ps1`
- Runtime: `C:\ProgramData\CodexFocusLock\Restore-QQTempExpiry.ps1`

**Interfaces:**
- Consumes: Tasks 1–6 source and tests.
- Produces: migrated format-2 live vault, matching source/runtime hashes, working Sunday policy, and verified barriers.

- [ ] **Step 1: Run the complete relevant test suite before deployment**

```powershell
Get-ChildItem plugin/mashirobot-plugin-game-timer/tests -Filter '*.test.mjs' | ForEach-Object { node --test $_.FullName; if($LASTEXITCODE-ne 0){throw "Node test failed: $($_.FullName)"} }
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-container.ps1
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-worker.ps1
pwsh -NoProfile -NonInteractive -File plugin/mashirobot-plugin-game-timer/qq/tests/test-qq-install-contract.ps1
```

Expected: all tests pass; unrelated pre-existing skipped tests remain documented, not converted into failures.

- [ ] **Step 2: Capture bounded pre-deployment evidence**

Record current task principals/states, current internal vault record, original-path existence, protected-file hash/signature, database/WAL/SHM files, FocusLock state, and source/runtime hashes. Save recoverable backups under the existing timestamped `C:\ProgramData\MashiroBot\migration-backups\qq-session-*` pattern.

- [ ] **Step 3: Run the elevated deployment**

Use PowerShell 7 and the canonical deploy script from an elevated process:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\qq\powershell\deploy-qq-session.ps1
```

The deployment stops reconcile, backs up state, installs source, migrates the active plaintext vault to format 2 under SYSTEM, deploys tracked temporary-release scripts, reapplies FocusLock, and restarts reconcile.

- [ ] **Step 4: Verify encrypted migration without revealing the path in normal output**

Run an elevated internal verifier that checks the path privately and emits only booleans/hashes:

```text
FormatVersion=2
ContainerExists=true
ContainerStartsWithMZ=false
ContainerRoundTripHashMatches=true
LegacyPlaintextVaultExists=false
PublicStatusLeaksVaultPath=false
OriginalQQExists=false
```

Also verify source/live SHA-256 equality for worker, helper, DB helper, storage, and model.

- [ ] **Step 5: Verify scheduler, FocusLock, and normal control behavior**

Require:

```text
MashiroBot-QQSession-Reconcile: SYSTEM / Highest / LastTaskResult=0
MashiroBot-QQSession-Launch: current user / Limited
Phase=ready
VaultState=protected
VaultReady=true
ClientBarrierActive=true
WebsiteBlockActive=true
QQProcessCount=0
```

Run ordinary command parser checks proving normal daily commands still reject before noon, at/after 22:00, and when their end crosses 22:00.

- [ ] **Step 6: Verify Sunday behavior with controlled timestamps, not a live four-hour wait**

Use model/parser/worker fixture clocks to prove Sunday 21:00 → Monday 01:00 and once-per-date behavior. Do not start a real four-hour QQ session merely for testing. On the live database, verify schema/index presence and that no synthetic consumed Sunday row was inserted.

- [ ] **Step 7: Verify temporary release compatibility without leaving QQ released**

Use a short controlled release only if explicitly authorized at execution time; otherwise run the tracked script's dry-run/fixture verification and inspect task contracts. The final live state must be protected, authorization inactive, expiry task absent or expired, reconcile enabled, and no QQ process/window.

- [ ] **Step 8: Restart and verify the OpenClaw gateway**

Restart through the repository's existing runtime control, then require gateway health `OK`, listener port 18789 present, and the installed plugin help containing the Sunday command. Compare source/runtime hashes again after restart.

