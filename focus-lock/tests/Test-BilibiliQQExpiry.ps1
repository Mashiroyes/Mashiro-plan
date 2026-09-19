$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'FocusLock.ps1'
$originalProgramData = $env:ProgramData
$fixtureRoot = Join-Path $env:TEMP ('CodexFocusLockExpiryTest-' + [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

try {
    New-Item -ItemType Directory -Path (Join-Path $fixtureRoot 'CodexFocusLock') -Force | Out-Null
    $env:ProgramData = $fixtureRoot
    $expiryPath = Join-Path $fixtureRoot 'CodexFocusLock\bilibili-qq-expiry.json'

    [pscustomobject]@{ ExpiresAt = (Get-Date).AddDays(1).ToString('o'); Status = 'Scheduled'; Notify = $false } |
        ConvertTo-Json | Set-Content -LiteralPath $expiryPath -Encoding UTF8
    . $source -Mode Status | Out-Null
    Assert-True (-not $bilibiliQQReleased) 'Future expiry was treated as released.'
    Assert-True ($blockedHosts -contains 'bilibili.com') 'Bilibili missing before expiry.'
    Assert-True ($blockedHosts -contains 'im.qq.com') 'QQ missing before expiry.'
    Assert-True ($blockedHosts -contains 'hanime1.me') 'Permanent host missing before expiry.'

    [pscustomobject]@{ ExpiresAt = (Get-Date).AddMinutes(-1).ToString('o'); Status = 'Scheduled'; Notify = $false } |
        ConvertTo-Json | Set-Content -LiteralPath $expiryPath -Encoding UTF8
    . $source -Mode Status | Out-Null
    Assert-True $bilibiliQQReleased 'Past expiry was not treated as released.'
    Assert-True ($blockedHosts -notcontains 'bilibili.com') 'Bilibili remained after expiry.'
    Assert-True ($blockedHosts -contains 'im.qq.com') 'QQ website block was incorrectly released with Bilibili.'
    Assert-True ($blockedImages.Count -gt 0) 'QQ image blocks were incorrectly released with Bilibili.'
    Assert-True ($blockedHosts -contains 'hanime1.me') 'Permanent host was removed after expiry.'
    Assert-True ($clashRules -contains 'DOMAIN-SUFFIX,hanime1.me,REJECT') 'Permanent Clash rule was removed.'

    [pscustomobject]@{ ExpiresAt = (Get-Date).AddDays(1).ToString('o'); Status = 'Scheduled'; BilibiliReleaseUntil = (Get-Date).AddMinutes(30).ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $expiryPath -Encoding UTF8
    . $source -Mode Status | Out-Null
    Assert-True $bilibiliTemporarilyReleased 'Active Bilibili temporary release was not recognized.'
    Assert-True ($blockedHosts -notcontains 'bilibili.com') 'Bilibili remained blocked during its temporary release.'
    Assert-True ($blockedHosts -contains 'im.qq.com') 'QQ was released with Bilibili.'
    Assert-True ($blockedImages.Count -gt 0) 'QQ image blocks were removed with Bilibili.'

    'PASS: Bilibili/QQ expiry filtering preserves permanent rules.'
}
finally {
    $env:ProgramData = $originalProgramData
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
