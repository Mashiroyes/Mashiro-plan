$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('mashirobot-block-worker-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
try {
    $db = Join-Path $root 'rules.sqlite'
    $node = (Get-Command node.exe).Source
    $plugin = Split-Path -Parent $PSScriptRoot
    & $node (Join-Path $plugin 'powershell\block-db-v1.mjs') active $db 2>$null
    if ($LASTEXITCODE -eq 0) { throw 'Expected missing database fixture to fail.' }
    $fixture = Join-Path $root 'fixture.yaml'
    Set-Content -LiteralPath $fixture -Value "rules:`n  - MATCH,DIRECT" -Encoding UTF8
    $text = Get-Content -LiteralPath $fixture -Raw
    if ($text -notmatch 'rules:') { throw 'Fixture was not created.' }
    $worker = Join-Path $plugin 'powershell\BlockWorker.ps1'
    $legacyTemplate = Join-Path $plugin 'powershell\bilibili-qq-expiry.default.json'
    if (-not (Test-Path -LiteralPath $legacyTemplate -PathType Leaf)) { throw 'Plugin must include the legacy FocusLock state template.' }
    $templateState = Get-Content -LiteralPath $legacyTemplate -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($templateState.QQReleased -ne $false) { throw 'Legacy FocusLock template must keep QQ blocked.' }
    $workerSource = Get-Content -LiteralPath $worker -Raw -Encoding UTF8
    if ($workerSource -notmatch '\$ClashReloadBudgetMs\s*=\s*12000') { throw 'Worker must use the bounded 12-second Clash reload budget.' }
    if ($workerSource -notmatch '\$ClashRestartBudgetMs\s*=\s*10000') { throw 'Worker must use a bounded 10-second Mihomo restart budget.' }
    if ($workerSource -notmatch '\$reloadResult\.Error') { throw 'Worker must propagate the final Clash reload error.' }
    if ($workerSource -notmatch 'function Invoke-ClashHttpReload') { throw 'Worker must define the loopback HTTP reload transport.' }
    if ($workerSource -notmatch 'http://127\.0\.0\.1:9097/configs\?force=true') { throw 'Worker HTTP fallback must remain loopback-only.' }
    if ($workerSource -notmatch 'UseProxy\s*=\s*\$false') { throw 'Worker HTTP fallback must bypass configured proxies.' }
    if ($workerSource -notmatch 'function Invoke-ClashProcessRestart') { throw 'Worker must define a Mihomo restart fallback.' }
    if ($workerSource -notmatch "Stop-Process\s+-Force") { throw 'Worker restart fallback must stop the stale Mihomo process.' }
    if ($workerSource -notmatch "Method='restart'") { throw 'Worker must report restart as the successful reload method.' }
    if ($workerSource -notmatch 'oldProcessIds\s+-notcontains\s+\$process\.Id') { throw 'Worker must verify that a fresh Mihomo process returned.' }
    if ($workerSource -notmatch 'function New-LegacyFocusLockState') { throw 'Worker must define a safe legacy FocusLock state.' }
    if ($workerSource -notmatch 'QQReleased\s*=\s*\$false') { throw 'Recovered legacy state must keep QQ blocked.' }
    if ($workerSource -notmatch 'function Read-LegacyFocusLockState') { throw 'Worker must safely read or rebuild the legacy FocusLock state.' }
    if ($workerSource -notmatch 'function Submit-BilibiliTimeoutPrompts') { throw 'Worker must submit a reading prompt after a verified Bilibili timeout.' }
    if ($workerSource -notmatch "bilibili:\{0\}") { throw 'Bilibili timeout event keys must remain expiry-specific.' }
    if ($workerSource -notmatch 'expiredReleases') { throw 'Worker must receive expired temporary-release records from SQLite.' }
    if ($workerSource -match 'function Stop-BilibiliBrowsersAfterExpiry') { throw 'Worker must not close browsers after Bilibili expiry.' }
    if ($workerSource -match 'bilibiliExpiryBrowserShutdown') { throw 'Worker must not expose a browser-shutdown synchronization layer.' }
    if ($workerSource -notmatch 'function New-ManagedClashRules') { throw 'Worker must render explicit DIRECT rules for released domains.' }
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw "Worker parsing failed: $($parseErrors[0].Message)" }
    $functionNames = @('Remove-MarkedBlock','Remove-ClashDomainRules','Add-YamlBlock','New-ManagedClashRules')
    foreach ($name in $functionNames) {
        $definition = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
        if (-not $definition) { throw "Missing testable worker function: $name" }
        Invoke-Expression $definition.Extent.Text
    }
    $MarkerStart = '# BEGIN MASHIROBOT BLOCK'
    $MarkerEnd = '# END MASHIROBOT BLOCK'
    $baseRules = Remove-ClashDomainRules "rules:`n- DOMAIN-SUFFIX,zhihu.com,REJECT`n- MATCH,DIRECT" @('zhihu.com')
    $rendered = Add-YamlBlock $baseRules (New-ManagedClashRules @('bilibili.com','zhihu.com') @('zhihu.com'))
    if ($rendered -notmatch '(?s)DOMAIN-SUFFIX,zhihu\.com,DIRECT.*DOMAIN-SUFFIX,bilibili\.com,REJECT') { throw 'Released DIRECT must precede enforced REJECT.' }
    if ($rendered -match 'DOMAIN-SUFFIX,zhihu\.com,REJECT') { throw 'Released domain must not retain a REJECT rule.' }
    $restored = Add-YamlBlock $rendered (New-ManagedClashRules @('bilibili.com','zhihu.com') @())
    if ($restored -match 'DOMAIN-SUFFIX,zhihu\.com,DIRECT') { throw 'Expired release must remove its DIRECT rule.' }
    if ($restored -notmatch 'DOMAIN-SUFFIX,zhihu\.com,REJECT') { throw 'Expired release must restore its REJECT rule.' }
    $installerSource = Get-Content -LiteralPath (Join-Path $plugin 'powershell\install-block.ps1') -Raw -Encoding UTF8
    if ($installerSource -notmatch 'bilibili-qq-expiry\.default\.json') { throw 'Installer must deploy the legacy FocusLock template with the worker.' }
    $syntax = & (Get-Command pwsh.exe).Source -NoProfile -NonInteractive -File $worker -Mode Status -StateRoot $root
    if ($LASTEXITCODE -ne 0 -or $syntax -notmatch '"ok":true') { throw "Worker status failed: $syntax" }
    & $node (Join-Path $plugin 'tests\worker-fixture.mjs') $db
    $dry = & (Get-Command pwsh.exe).Source -NoProfile -NonInteractive -File $worker -Mode Reapply -SqlitePath $db -StateRoot $root -DryRun
    if ($LASTEXITCODE -ne 0 -or $dry -notmatch '"ruleCount":2') { throw "Worker DryRun failed: $dry" }
    $dryResult = $dry | ConvertFrom-Json
    if ($dryResult.layers.PSObject.Properties.Name -contains 'bilibiliExpiryBrowserShutdown') { throw 'Ordinary synchronization must not expose browser shutdown.' }

    $expiryDb = Join-Path $root 'expiry-rules.sqlite'
    & $node (Join-Path $plugin 'tests\worker-fixture.mjs') $expiryDb 'expired-bilibili'
    $expiryDry = & (Get-Command pwsh.exe).Source -NoProfile -NonInteractive -File $worker -Mode Reapply -SqlitePath $expiryDb -StateRoot (Join-Path $root 'expiry-state') -DryRun
    if ($LASTEXITCODE -ne 0) { throw "Expired Bilibili DryRun failed: $expiryDry" }
    $expiryResult = $expiryDry | ConvertFrom-Json
    if ($expiryResult.layers.PSObject.Properties.Name -contains 'bilibiliExpiryBrowserShutdown') { throw 'Expired Bilibili synchronization must not expose browser shutdown.' }
    if (-not $expiryResult.layers.hosts.ok -or -not $expiryResult.layers.browserPolicy.ok -or -not $expiryResult.layers.clashReload.ok) { throw 'Expired Bilibili must still restore all blocking layers.' }
    [pscustomobject]@{ ok = $true; dryRunFixture = $fixture } | ConvertTo-Json -Compress
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
