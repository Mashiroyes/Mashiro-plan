$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'Release-BilibiliQQ.ps1'
$fixtureRoot = Join-Path $env:TEMP ('CodexFocusLockReleaseTest-' + [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

try {
    $clashProfiles = Join-Path $fixtureRoot 'clash\profiles'
    $quarantine = Join-Path $fixtureRoot 'quarantine'
    $downloads = Join-Path $fixtureRoot 'Downloads'
    New-Item -ItemType Directory -Path $clashProfiles,$quarantine,$downloads -Force | Out-Null

    @'
# BEGIN CODEX FOCUS LOCK
0.0.0.0 bilibili.com
0.0.0.0 im.qq.com
0.0.0.0 hanime1.me
# END CODEX FOCUS LOCK
127.0.0.1 unrelated.example
'@ | Set-Content -LiteralPath (Join-Path $fixtureRoot 'hosts') -Encoding UTF8

    @(
        [pscustomobject]@{ Name='9000'; Value='*://*.bilibili.com/*' },
        [pscustomobject]@{ Name='9001'; Value='*://im.qq.com/*' },
        [pscustomobject]@{ Name='9002'; Value='*://*.hanime1.me/*' },
        [pscustomobject]@{ Name='42'; Value='*://unrelated.example/*' }
    ) | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'policies.json') -Encoding UTF8

    [pscustomobject]@{
        'QQ.exe' = 'C:\Windows\System32\cmd.exe /d /c exit'
        'QQNT.exe' = 'C:\Windows\System32\cmd.exe /d /c exit'
        'Unrelated.exe' = 'keep'
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'ifeo.json') -Encoding UTF8

    [pscustomobject]@{
        IfeoBackups = @(
            [pscustomobject]@{ Image='QQ.exe'; KeyExisted=$false; DebuggerExisted=$false; DebuggerValue=$null },
            [pscustomobject]@{ Image='QQNT.exe'; KeyExisted=$true; DebuggerExisted=$true; DebuggerValue='original-debugger' }
        )
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'state.json') -Encoding UTF8

    [pscustomobject]@{ ExpiresAt='2026-08-18T20:08:00+08:00'; Status='Scheduled'; Notify=$false } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRoot 'bilibili-qq-expiry.json') -Encoding UTF8

    @'
prepend:
  # BEGIN CODEX FOCUS LOCK
  - DOMAIN-SUFFIX,bilibili.com,REJECT
  - DOMAIN,im.qq.com,REJECT
  - DOMAIN-SUFFIX,hanime1.me,REJECT
  # END CODEX FOCUS LOCK
  - DOMAIN-SUFFIX,unrelated.example,DIRECT
'@ | Set-Content -LiteralPath (Join-Path $clashProfiles 'fixture.yaml') -Encoding UTF8

    $stored = Join-Path $quarantine '20260811__QQSetup.exe'
    $original = Join-Path $downloads 'QQSetup.exe'
    'fixture installer' | Set-Content -LiteralPath $stored -Encoding UTF8
    $original | Set-Content -LiteralPath ($stored + '.origin.txt') -Encoding UTF8

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $source -FixtureRoot $fixtureRoot
    if ($LASTEXITCODE -ne 0) { throw "Release fixture failed with exit code $LASTEXITCODE" }

    $hosts = Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'hosts')
    Assert-True ($hosts -notmatch 'bilibili\.com') 'Bilibili hosts entry remained.'
    Assert-True ($hosts -notmatch 'im\.qq\.com') 'QQ hosts entry remained.'
    Assert-True ($hosts -match 'hanime1\.me') 'Permanent hosts entry was removed.'
    Assert-True ($hosts -match 'unrelated\.example') 'Unrelated hosts entry was removed.'

    $policies = @(Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'policies.json') | ConvertFrom-Json)
    Assert-True (-not ($policies.Value -match 'bilibili|im\.qq')) 'Bilibili/QQ policy remained.'
    Assert-True ($policies.Value -contains '*://*.hanime1.me/*') 'Permanent policy was removed.'
    Assert-True ($policies.Value -contains '*://unrelated.example/*') 'Unrelated policy was removed.'

    $ifeo = Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'ifeo.json') | ConvertFrom-Json
    Assert-True ($null -eq $ifeo.PSObject.Properties['QQ.exe']) 'QQ.exe IFEO block remained.'
    Assert-True ($ifeo.'QQNT.exe' -eq 'original-debugger') 'QQNT original debugger was not restored.'
    Assert-True ($ifeo.'Unrelated.exe' -eq 'keep') 'Unrelated IFEO entry changed.'

    $clash = Get-Content -Raw -LiteralPath (Join-Path $clashProfiles 'fixture.yaml')
    Assert-True ($clash -notmatch 'bilibili\.com') 'Bilibili Clash rule remained.'
    Assert-True ($clash -notmatch 'DOMAIN,im\.qq\.com') 'QQ Clash rule remained.'
    Assert-True ($clash -match 'hanime1\.me') 'Permanent Clash rule was removed.'
    Assert-True ($clash -match 'unrelated\.example') 'Unrelated Clash rule was removed.'

    Assert-True (Test-Path -LiteralPath $original) 'Quarantined QQ installer was not restored.'
    $expiry = Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'bilibili-qq-expiry.json') | ConvertFrom-Json
    Assert-True ($expiry.Status -eq 'Released') 'Expiry state was not marked released.'
    Assert-True ($expiry.Notify -eq $false) 'Notification flag changed.'
    $result = Get-Content -Raw -LiteralPath (Join-Path $fixtureRoot 'bilibili-qq-release-result.json') | ConvertFrom-Json
    Assert-True ($result.NotificationSent -eq $false) 'Result incorrectly reports a notification.'

    'PASS: release removes only Bilibili/QQ and sends no notification.'
}
finally {
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
