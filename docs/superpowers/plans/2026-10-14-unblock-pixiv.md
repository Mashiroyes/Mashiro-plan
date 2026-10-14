# Permanently Unblock Pixiv Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently remove the Windows-wide Pixiv and pximg restriction, including Clash/Mihomo enforcement, without weakening unrelated FocusLock controls.

**Architecture:** Remove Pixiv from the repository policy source and its contract test first, then deploy the changed source and reapply FocusLock so its managed hosts, browser policy, and Clash blocks converge on the new policy. Finish with static scans and real direct/proxy requests that distinguish a local reject from a remote response.

**Tech Stack:** PowerShell 7, Windows hosts and registry policy, Clash Verge Rev/Mihomo YAML, curl, Git.

## Global Constraints

- Keep Cloudflare Families DNS and browser secure-DNS restrictions unchanged.
- Preserve MissAV, QQ, Bilibili, HAnime, application, and game restrictions.
- Remove both `pixiv.net` and `pximg.net` from every local enforcement layer.
- Use PowerShell 7 for scripts and tests.
- Do not overwrite unrelated committed workspace changes.

---

### Task 1: Change the Persistent FocusLock Policy Contract

**Files:**
- Modify: `focus-lock/tests/Test-BilibiliQQExpiry.ps1:21-26`
- Modify: `focus-lock/FocusLock.ps1:111-120`
- Modify: `focus-lock/FocusLock.ps1:144-153`
- Modify: `focus-lock/FocusLock.ps1:186-191`

**Interfaces:**
- Consumes: `$permanentBlockedHosts`, `$permanentBrowserPatterns`, and `$permanentClashRules` arrays evaluated when dot-sourcing `FocusLock.ps1 -Mode Status`.
- Produces: a permanent policy containing HAnime and MissAV but no domain or browser/Clash rule matching `pixiv.net` or `pximg.net`.

- [ ] **Step 1: Change the contract test to require Pixiv to be absent**

Replace the Pixiv assertions with:

```powershell
Assert-True ($blockedHosts -notcontains 'pixiv.net') 'Pixiv host restriction still exists.'
Assert-True ($blockedHosts -notcontains 'pximg.net') 'Pixiv image host restriction still exists.'
Assert-True ($clashRules -notcontains 'DOMAIN-SUFFIX,pixiv.net,REJECT') 'Pixiv Clash restriction still exists.'
Assert-True ($clashRules -notcontains 'DOMAIN-SUFFIX,pximg.net,REJECT') 'Pixiv image Clash restriction still exists.'
Assert-True ($browserPatterns -notcontains '*://*.pixiv.net/*') 'Pixiv browser restriction still exists.'
Assert-True ($browserPatterns -notcontains '*://*.pximg.net/*') 'Pixiv image browser restriction still exists.'
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```powershell
pwsh -NoProfile -File .\focus-lock\tests\Test-BilibiliQQExpiry.ps1
```

Expected: FAIL because Pixiv is still in at least one policy array.

- [ ] **Step 3: Remove only Pixiv entries from the source arrays**

Delete these exact entries from `focus-lock/FocusLock.ps1`:

```powershell
'pixiv.net'
'www.pixiv.net'
'pximg.net'
'i.pximg.net'
'*://pixiv.net/*'
'*://*.pixiv.net/*'
'*://pximg.net/*'
'*://*.pximg.net/*'
'DOMAIN-SUFFIX,pixiv.net,REJECT'
'DOMAIN-SUFFIX,pximg.net,REJECT'
```

- [ ] **Step 4: Run the focused test and the full FocusLock test set**

Run:

```powershell
pwsh -NoProfile -File .\focus-lock\tests\Test-BilibiliQQExpiry.ps1
Get-ChildItem .\focus-lock\tests\Test-*.ps1 | ForEach-Object { pwsh -NoProfile -File $_.FullName; if ($LASTEXITCODE -ne 0) { throw "Test failed: $($_.Name)" } }
```

Expected: every test prints its PASS result and exits with code 0.

- [ ] **Step 5: Commit the persistent policy change**

```powershell
git add focus-lock/FocusLock.ps1 focus-lock/tests/Test-BilibiliQQExpiry.ps1 docs/superpowers/plans/2026-10-14-unblock-pixiv.md
git commit -m "feat: permanently unblock Pixiv"
```

### Task 2: Deploy, Reapply, and Verify the Computer-Wide Release

**Files:**
- Modify at runtime: `C:\ProgramData\CodexFocusLock\FocusLock.ps1`
- Modify at runtime: `C:\Windows\System32\drivers\etc\hosts`
- Modify at runtime: `HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist`
- Modify at runtime: `HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist`
- Modify at runtime: `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml`
- Modify at runtime: `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\clash-verge-check.yaml`
- Modify at runtime: `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\profiles\*.yaml`

**Interfaces:**
- Consumes: repository `focus-lock/FocusLock.ps1` and existing `C:\ProgramData\CodexFocusLock\state.json`.
- Produces: deployed source with matching SHA-256, no effective Pixiv host/browser/Clash restriction, and real Pixiv requests that are not locally rejected.

- [ ] **Step 1: Deploy the source without replacing state**

Copy `focus-lock/FocusLock.ps1` over the deployed copy using an elevated PowerShell 7 process. Compare SHA-256 hashes and require equality before continuing.

- [ ] **Step 2: Reapply the existing FocusLock state**

Run the deployed script elevated:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\CodexFocusLock\FocusLock.ps1 -Mode Reapply
```

Expected: exit code 0. Existing state remains installed; the generated managed blocks no longer contain Pixiv or pximg.

- [ ] **Step 3: Remove stale Pixiv rules outside the current managed block**

Scan hosts, both browser `URLBlocklist` keys, `clash-verge.yaml`, `clash-verge-check.yaml`, and every `profiles\*.yaml`. Remove only entries matching `(?i)(pixiv\.net|pximg\.net)`; preserve all other entries and YAML ordering.

- [ ] **Step 4: Reload the active Clash runtime**

If the controller cannot be authenticated, restart Clash Verge/Mihomo through the existing service or app process. Confirm the configured local proxy listener is active before request tests.

- [ ] **Step 5: Verify every enforcement layer**

Require all of the following:

```text
Repository FocusLock scan: 0 Pixiv/pximg hits
Deployed FocusLock scan: 0 Pixiv/pximg hits
Hosts scan: 0 Pixiv/pximg hits
Chrome URLBlocklist: 0 Pixiv/pximg values
Edge URLBlocklist: 0 Pixiv/pximg values
All Clash YAML files: 0 Pixiv/pximg REJECT hits
MissAV/HAnime or another preserved restriction: still present
```

- [ ] **Step 6: Verify real network behavior**

Use curl with timeouts:

```powershell
curl.exe --noproxy '*' -L -I --max-time 20 https://www.pixiv.net/
curl.exe --proxy http://127.0.0.1:7897 -L -I --max-time 20 https://www.pixiv.net/
curl.exe --proxy http://127.0.0.1:7897 -L -I --max-time 20 https://i.pximg.net/
curl.exe --proxy http://127.0.0.1:7897 -L -I --max-time 20 https://example.com/
```

Accept any remote HTTP response for Pixiv/pximg, including 403, as proof that the local block is gone. Reject connection failures caused by local DNS resolution or a Clash `REJECT` rule. The normal-site control must return a remote response.

- [ ] **Step 7: Record and commit any required repository-only correction**

If deployment revealed a source-only defect, patch it, rerun Task 1 tests, and commit only that correction. Runtime state and machine-local Clash files are not added to Git.
