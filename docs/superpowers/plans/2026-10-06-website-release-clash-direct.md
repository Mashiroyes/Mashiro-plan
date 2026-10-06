# Website Release Clash DIRECT Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a temporary website release override Clash subscription-level blocking with a highest-priority `DIRECT` rule, and remove that override automatically when the release ends.

**Architecture:** Extend the existing PowerShell block worker's managed Clash rule block. It will rebuild the block as `DIRECT` rules for currently released domains followed by `REJECT` rules for currently blocked domains, while preserving the existing database, hosts, browser-policy, reload and scheduled reconciliation flows.

**Tech Stack:** PowerShell 7, Clash/Mihomo YAML rules, Node.js `node:sqlite`, existing PowerShell worker tests.

## Global Constraints

- Do not disable Clash or modify the remote subscription.
- Do not change release quotas, durations, database semantics, or bot replies.
- A released domain must not have a generated `REJECT` rule.
- An expired or restored release must lose its generated `DIRECT` rule and regain `REJECT` when its permanent block remains active.
- Preserve Bilibili related-domain expansion.

---

### Task 1: Generate managed DIRECT rules for active releases

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1:209-408`
- Test: `plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1`

**Interfaces:**
- Consumes: `$domains` as currently enforced domains and `$releasedDomains` as expanded active-release domains.
- Produces: `Set-ClashRules($domains, $releasedDomains, $state)` that places `DOMAIN-SUFFIX,<released>,DIRECT` before generated `DOMAIN-SUFFIX,<blocked>,REJECT` rules.

- [ ] **Step 1: Add failing source-contract and fixture assertions**

Add assertions to `test-worker.ps1` requiring a released-domain `DIRECT` generator, ordering `DIRECT` before `REJECT`, and cleanup of stale managed `DIRECT` rules. Extend the test fixture to use a temporary Clash rule-provider file and assert that an active `zhihu.com` release produces:

```yaml
# BEGIN PLAN MASHIROBOT BLOCK
- DOMAIN-SUFFIX,zhihu.com,DIRECT
- DOMAIN-SUFFIX,bilibili.com,REJECT
# END PLAN MASHIROBOT BLOCK
```

and never produces `DOMAIN-SUFFIX,zhihu.com,REJECT`.

- [ ] **Step 2: Run the worker test and verify failure**

Run:

```powershell
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
```

Expected: FAIL because the worker removes released-domain rejects but does not generate a DIRECT override.

- [ ] **Step 3: Implement deterministic managed-rule rendering**

In `BlockWorker.ps1`, update Clash cleanup so it removes stale managed or legacy `DIRECT` and `REJECT` entries for domains controlled by the worker. Build one ordered rule list:

```powershell
$managedRules = @(
    @($releasedDomains | Sort-Object -Unique | ForEach-Object { "DOMAIN-SUFFIX,$_,DIRECT" })
    @($domains | Where-Object { $releasedDomains -notcontains $_ } | Sort-Object -Unique |
        ForEach-Object { "DOMAIN-SUFFIX,$_,REJECT" })
)
```

Insert this list through the existing `Add-YamlBlock` path for both persistent provider and generated runtime config. Keep the existing reload-pending/error behavior.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
node --test plugin/mashirobot-plugin-game-timer/block/tests/*.test.mjs
```

Expected: all tests pass and the fixture proves DIRECT-before-REJECT ordering.

- [ ] **Step 5: Commit implementation**

```powershell
git add plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1 plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
git commit -m "fix: override Clash blocks during website release"
```

### Task 2: Deploy and verify the active Zhihu release

**Files:**
- Deploy from: `plugin/mashirobot-plugin-game-timer/block/powershell/BlockWorker.ps1`
- Deploy with: `plugin/mashirobot-plugin-game-timer/block/powershell/install-block.ps1`
- Verify: `C:\ProgramData\MashiroBot\mashirobot-plugin-block\workers\block-worker-v2.ps1`
- Verify: `C:\ProgramData\MashiroBot\mashirobot-plugin-block\state.json`

**Interfaces:**
- Consumes: current SQLite `block_releases` record for `zhihu.com` and scheduled Reapply/Scan tasks.
- Produces: deployed worker, reloaded Clash runtime, and live proxy access during the release.

- [ ] **Step 1: Run the full relevant regression suite**

Run:

```powershell
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
node --test plugin/mashirobot-plugin-game-timer/block/tests/*.test.mjs
node --test plugin/mashirobot-plugin-game-timer/tests/*.test.mjs
```

Expected: all relevant tests pass.

- [ ] **Step 2: Deploy the worker with elevation**

Run the existing installer using PowerShell 7 and the repository SQLite path. Do not hand-edit ProgramData:

```powershell
pwsh -NoProfile -File plugin/mashirobot-plugin-game-timer/block/powershell/install-block.ps1
```

Expected: both scheduled tasks remain registered and the deployed worker hash matches the source worker hash.

- [ ] **Step 3: Force reconciliation and inspect evidence**

Start `MashiroBot-mashirobot-plugin-block-Reapply`, wait for completion, then inspect `state.json`. Expected fields:

```json
{
  "LastSync": {
    "ok": true,
    "releasedDomainCount": 1
  }
}
```

The active persistent and generated Clash configs must contain `DOMAIN-SUFFIX,zhihu.com,DIRECT` before any general subscription rules and no generated `zhihu.com,REJECT`.

- [ ] **Step 4: Verify live proxy access**

Run:

```powershell
curl.exe -I -L --max-time 15 https://www.zhihu.com/
```

Expected: TLS succeeds and an HTTP response is returned through `127.0.0.1:7897`; direct access remains a control check, not the acceptance result.

- [ ] **Step 5: Verify restoration behavior without consuming quota**

Use an isolated fixture/dry-run test for expiry rather than mutating the user's live release. Confirm that removing the release causes the managed DIRECT rule to disappear and the permanent Zhihu rule to return as REJECT.

- [ ] **Step 6: Commit any deployment documentation evidence if changed**

Only if validation documentation was updated:

```powershell
git add plugin/mashirobot-plugin-game-timer/block/VALIDATION.md
git commit -m "docs: record Clash release override validation"
```
