# Adult Content and Pixiv Permanent Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently block Pixiv and category-filter adult websites on this Windows computer with self-repairing FocusLock enforcement.

**Architecture:** Extend the existing FocusLock rule generator with an auditable permanent-domain configuration, family-filter DNS enforcement, browser DoH restrictions, and status evidence. Preserve Clash as the managed proxy while rejecting explicit target domains in every active/generated profile and blocking other detected proxy/VPN clients.

**Tech Stack:** PowerShell 7, Windows DNS client, Chrome/Edge enterprise policies, hosts, Clash Verge/Mihomo YAML, Scheduled Tasks.

## Global Constraints

- Preserve all existing Bilibili and QQ behavior and state.
- Do not add a temporary release path for adult-content or Pixiv rules.
- Back up changed DNS and policy state before first installation.
- A failed layer must be reported as unverified or failed; it must not be presented as a verified block.
- Use PowerShell 7 for repository and deployment commands.

---

### Task 1: Permanent target configuration and rule generation

**Files:**
- Create: `focus-lock/adult-content-targets.psd1`
- Modify: `focus-lock/FocusLock.ps1:111-195`
- Modify: `focus-lock/tests/Test-BilibiliQQExpiry.ps1`

**Interfaces:**
- Produces: imported arrays `ExplicitDomains`, `BrowserPatterns`, `ClashRules`, and `BlockedProxyImages`.
- Consumes: existing `$permanentBlockedHosts`, `$permanentBrowserPatterns`, `$permanentClashRules`, and `$blockedImages` pipelines.

- [ ] **Step 1: Add failing permanent-rule assertions**

```powershell
Assert-True ($blockedHosts -contains 'pixiv.net') 'Pixiv host is not permanent.'
Assert-True ($blockedHosts -contains 'pximg.net') 'Pixiv image host is not permanent.'
Assert-True ($blockedHosts -contains 'missav.com') 'MissAV host is not permanent.'
Assert-True ($clashRules -contains 'DOMAIN-SUFFIX,pixiv.net,REJECT') 'Pixiv Clash rule is missing.'
Assert-True ($browserPatterns -contains '*://*.missav.com/*') 'MissAV browser policy is missing.'
```

- [ ] **Step 2: Run the test and verify the new assertions fail**

Run: `pwsh -NoProfile -File ./focus-lock/tests/Test-BilibiliQQExpiry.ps1`

Expected: FAIL on the first missing adult/Pixiv rule.

- [ ] **Step 3: Add the data file and import it**

```powershell
@{
    ExplicitDomains = @('pixiv.net','www.pixiv.net','pximg.net','i.pximg.net','missav.com','www.missav.com')
    BrowserPatterns = @('*://pixiv.net/*','*://*.pixiv.net/*','*://pximg.net/*','*://*.pximg.net/*','*://missav.com/*','*://*.missav.com/*')
    ClashRules = @('DOMAIN-SUFFIX,pixiv.net,REJECT','DOMAIN-SUFFIX,pximg.net,REJECT','DOMAIN-SUFFIX,missav.com,REJECT')
    BlockedProxyImages = @('openvpn.exe','wireguard.exe','windscribe.exe','nordvpn.exe','expressvpn.exe','protonvpn.exe','tor.exe')
}
```

Load it with `Import-PowerShellDataFile`, append each array to the existing permanent rule arrays, and append only detected non-Clash proxy/VPN images to `$blockedImages`.

- [ ] **Step 4: Re-run the permanent-rule test**

Run: `pwsh -NoProfile -File ./focus-lock/tests/Test-BilibiliQQExpiry.ps1`

Expected: PASS.

- [ ] **Step 5: Commit the isolated rule change**

```powershell
git add -- focus-lock/adult-content-targets.psd1 focus-lock/FocusLock.ps1 focus-lock/tests/Test-BilibiliQQExpiry.ps1
git commit -m "feat: add permanent adult and pixiv targets"
```

### Task 2: Family-filter DNS and browser secure-DNS enforcement

**Files:**
- Modify: `focus-lock/FocusLock.ps1:201-365`
- Create: `focus-lock/tests/Test-AdultDnsPolicy.ps1`

**Interfaces:**
- Produces: `Get-EligibleDnsAdapters`, `Backup-DnsConfiguration`, `Set-AdultFilterDns`, `Restore-DnsConfiguration`, `Set-SecureDnsPolicies`, and status fields `AdultDnsManaged`, `SecureDnsDisabled`.
- Consumes: FocusLock state JSON and existing policy backup/restore conventions.

- [ ] **Step 1: Add fixture tests for DNS selection and policy values**

The fixture must assert that disconnected, loopback, Hyper-V, WSL, and Clash virtual adapters are excluded, while active physical Wi-Fi/Ethernet adapters are included. It must also assert Chrome `DnsOverHttpsMode=off` and Edge `DnsOverHttpsMode=off` under HKLM policy roots.

- [ ] **Step 2: Run the DNS policy test and verify missing functions fail**

Run: `pwsh -NoProfile -File ./focus-lock/tests/Test-AdultDnsPolicy.ps1`

Expected: FAIL because DNS helpers are undefined.

- [ ] **Step 3: Implement backup, enforcement, restore, and status**

Use `Get-NetAdapter -Physical`, `Get-DnsClientServerAddress`, and `Set-DnsClientServerAddress`. Save each interface index, address family, and original server list into `state.json` before changing it. Apply Cloudflare Families malware-and-adult filtering (`1.1.1.3`, `1.0.0.3`, `2606:4700:4700::1113`, `2606:4700:4700::1003`) to active physical adapters only; add Chrome/Edge `DnsOverHttpsMode=off` policy values without recreating policy keys on each run.

- [ ] **Step 4: Run fixture and existing FocusLock tests**

Run:

```powershell
pwsh -NoProfile -File ./focus-lock/tests/Test-AdultDnsPolicy.ps1
pwsh -NoProfile -File ./focus-lock/tests/Test-BilibiliQQExpiry.ps1
pwsh -NoProfile -File ./focus-lock/tests/Test-Release-BilibiliQQ.ps1
```

Expected: all PASS.

- [ ] **Step 5: Commit DNS enforcement**

```powershell
git add -- focus-lock/FocusLock.ps1 focus-lock/tests/Test-AdultDnsPolicy.ps1
git commit -m "feat: enforce adult filtering dns"
```

### Task 3: Installation, repair, removal, and status integration

**Files:**
- Modify: `focus-lock/FocusLock.ps1:547-704`
- Modify: `focus-lock/README.md`

**Interfaces:**
- Consumes: Task 2 DNS/policy functions.
- Produces: `Install` and `Reapply` enforcement, `Remove` restoration, and structured `Status` evidence for every layer.

- [ ] **Step 1: Wire each lifecycle mode**

`Install` must capture the DNS/policy backup before enforcement. `Reapply` and `Scan` must restore drift without replacing the saved backup. `Remove` must restore the captured DNS and prior policy values. `Status` must compare actual adapter DNS, hosts entries, browser patterns, active Clash rules, and detected blocked proxy images against expected values.

- [ ] **Step 2: Add repair-task regression coverage**

Extend the PowerShell fixture to remove one managed Pixiv hosts entry and one secure-DNS policy value, invoke `Reapply`, and assert both are restored without changing the Bilibili release state.

- [ ] **Step 3: Run all FocusLock tests**

Run: `Get-ChildItem ./focus-lock/tests/Test-*.ps1 | ForEach-Object { pwsh -NoProfile -File $_.FullName }`

Expected: every script prints PASS and exits 0.

- [ ] **Step 4: Document scope and administrator limit**

Document that FocusLock has no adult/Pixiv temporary release command, Clash remains permitted as the managed proxy, and a person retaining administrator control can ultimately remove local restrictions.

- [ ] **Step 5: Commit lifecycle integration**

```powershell
git add -- focus-lock/FocusLock.ps1 focus-lock/README.md focus-lock/tests
git commit -m "feat: repair permanent content controls"
```

### Task 4: Elevated deployment and end-to-end verification

**Files:**
- Runtime: `C:\ProgramData\CodexFocusLock\FocusLock.ps1`
- Runtime: `C:\Windows\System32\drivers\etc\hosts`
- Runtime: active Clash Verge YAML files under the configured app-data root
- Create: `focus-lock/adult-content-block-verification.json`

**Interfaces:**
- Consumes: repository `focus-lock/FocusLock.ps1 -Mode Install|Reapply|Status`.
- Produces: machine-local verification JSON containing per-layer evidence and control-site results.

- [ ] **Step 1: Run elevated install or reapply**

Use `Install` only if `C:\ProgramData\CodexFocusLock\state.json` is absent; otherwise use `Reapply`. Execute through an elevated PowerShell 7 process and wait for its result file rather than copying runtime files manually.

- [ ] **Step 2: Verify static layers**

Confirm the installed script hash matches the repository source, hosts contains the managed targets, both browser policy roots contain the target patterns, active physical adapters use the adult-filter DNS, active/generated Clash profiles contain all target `REJECT` rules, and repair/scan tasks report last result `0`.

- [ ] **Step 3: Verify access paths**

Test Cloudflare's `nudity.testcategory.com`, Pixiv, `i.pximg.net`, and MissAV both directly and through the active local Clash proxy. Each target must fail because of a local layer. Test a normal control site both ways and require a successful HTTP response or TLS connection.

- [ ] **Step 4: Verify self-repair**

Remove one disposable managed browser-policy value, run the repair task, and require the exact value to reappear with task result `0`. Do not remove hosts or DNS during this check because an interrupted repair could temporarily break unrelated connectivity.

- [ ] **Step 5: Save evidence and report limits accurately**

Write `adult-content-block-verification.json` with timestamps, DNS servers, matched policy values, Clash profile paths, request outcomes, control outcomes, and task results. Report “verified” only for layers whose checks completed successfully.

