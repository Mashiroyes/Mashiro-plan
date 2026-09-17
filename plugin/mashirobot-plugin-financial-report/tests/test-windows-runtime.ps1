$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $pluginRoot 'windows\delivery-worker.ps1'
$launcher = Join-Path $pluginRoot 'windows\run-worker.vbs'
$launcherSource = Get-Content -Raw -Encoding UTF8 $launcher
if ($launcherSource -notmatch 'shell\.Run\(command, 0, True\)') { throw 'hidden VBS launcher must run workers without a visible window' }
if ($launcherSource -notmatch 'WScript\.Arguments\.Count <> 5') { throw 'hidden VBS launcher must validate all worker arguments' }
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('mashiro-finance-worker-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
try {
    $commonPath = Join-Path $pluginRoot 'windows\common.ps1'
    $commonSource = Get-Content -Raw -Encoding UTF8 $commonPath
    if ($commonSource -notmatch [regex]::Escape('openclaw.ps1')) {
        throw 'ordinary WeChat delivery must use openclaw.ps1'
    }
    if ($commonSource -match '&\s*\$script:OpenClawCmd\s+message\s+send') {
        throw 'ordinary WeChat delivery still uses openclaw.cmd'
    }

    . $commonPath
    $capturePath = Join-Path $tempRoot 'captured-message.txt'
    $fakeOpenClaw = Join-Path $tempRoot 'openclaw.ps1'
    @'
param()
$messageIndex = [Array]::IndexOf($args, '--message')
[IO.File]::WriteAllText($env:MASHIRO_CAPTURE_PATH, [string]$args[$messageIndex + 1], [Text.UTF8Encoding]::new($false))
$global:LASTEXITCODE = 0
'{"ok":true,"messageId":"fake-multiline"}'
'@ | Set-Content -LiteralPath $fakeOpenClaw -Encoding utf8NoBOM
    $script:OpenClawPs1 = $fakeOpenClaw
    $env:MASHIRO_CAPTURE_PATH = $capturePath
    $expected = "【第 1 天财报课】`n`n【财报事实】`n营业收入`n`n【官方原文】`nhttps://example.test/report.pdf"
    Send-FinancialWeixinMessage -Message $expected | Out-Null
    if ([IO.File]::ReadAllText($capturePath, [Text.Encoding]::UTF8) -cne $expected) {
        throw 'multiline UTF-8 course card changed at the OpenClaw boundary'
    }

    $db = Join-Path $tempRoot 'test.sqlite'
    $cli = Join-Path $pluginRoot 'runtime\cli.mjs'
    $account = 'ea8fd13b2100-im-bot'
    $target = 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat'
    & node $cli init --sqlite-path $db --account-id $account --conversation-id $target --installed-date 2026-08-09 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'init failed' }
    $first = & pwsh -NoProfile -File $worker -CourseType financial_report -RuntimeRoot $tempRoot -SqlitePath $db -Now '2026-08-10T04:20:00Z' -DryRun | ConvertFrom-Json
    if ($first.action -ne 'sent' -or $first.utf8Length -lt 100) { throw 'Chinese dry-run delivery failed' }
    $second = & pwsh -NoProfile -File $worker -CourseType financial_report -RuntimeRoot $tempRoot -SqlitePath $db -Now '2026-08-10T04:21:00Z' -DryRun | ConvertFrom-Json
    if ($second.action -ne 'already_sent') { throw 'duplicate invocation was not idempotent' }
    $wrongDay = & pwsh -NoProfile -File $worker -CourseType prospectus -RuntimeRoot $tempRoot -SqlitePath $db -Now '2026-08-10T10:10:00Z' -DryRun | ConvertFrom-Json
    if ($wrongDay.action -ne 'wrong_day') { throw 'wrong weekday should not send' }
    @{ ok = $true; database = $db } | ConvertTo-Json -Compress
} finally {
    Remove-Item Env:MASHIRO_CAPTURE_PATH -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
