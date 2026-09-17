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
    $workerSource = Get-Content -LiteralPath $worker -Raw -Encoding UTF8
    if ($workerSource -notmatch '\$ClashReloadBudgetMs\s*=\s*12000') { throw 'Worker must use the bounded 12-second Clash reload budget.' }
    if ($workerSource -notmatch '\$reloadResult\.Error') { throw 'Worker must propagate the final Clash reload error.' }
    if ($workerSource -notmatch 'function Invoke-ClashHttpReload') { throw 'Worker must define the loopback HTTP reload transport.' }
    if ($workerSource -notmatch 'http://127\.0\.0\.1:9097/configs\?force=true') { throw 'Worker HTTP fallback must remain loopback-only.' }
    if ($workerSource -notmatch 'UseProxy\s*=\s*\$false') { throw 'Worker HTTP fallback must bypass configured proxies.' }
    $syntax = & (Get-Command pwsh.exe).Source -NoProfile -NonInteractive -File $worker -Mode Status -StateRoot $root
    if ($LASTEXITCODE -ne 0 -or $syntax -notmatch '"ok":true') { throw "Worker status failed: $syntax" }
    & $node (Join-Path $plugin 'tests\worker-fixture.mjs') $db
    $dry = & (Get-Command pwsh.exe).Source -NoProfile -NonInteractive -File $worker -Mode Reapply -SqlitePath $db -StateRoot $root -DryRun
    if ($LASTEXITCODE -ne 0 -or $dry -notmatch '"ruleCount":2') { throw "Worker DryRun failed: $dry" }
    [pscustomobject]@{ ok = $true; dryRunFixture = $fixture } | ConvertTo-Json -Compress
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
