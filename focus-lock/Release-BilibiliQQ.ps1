param(
    [string]$FixtureRoot
)

$ErrorActionPreference = 'Stop'
$taskName = 'CodexFocusLock-BilibiliQQExpire'
$isFixture = -not [string]::IsNullOrWhiteSpace($FixtureRoot)

if ($isFixture) {
    $stateRoot = $FixtureRoot
    $hostsPath = Join-Path $FixtureRoot 'hosts'
    $clashRoot = Join-Path $FixtureRoot 'clash'
    $policyFixturePath = Join-Path $FixtureRoot 'policies.json'
    $ifeoFixturePath = Join-Path $FixtureRoot 'ifeo.json'
} else {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Administrator privileges are required.'
    }
    $stateRoot = 'C:\ProgramData\CodexFocusLock'
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $clashRoot = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
}

$statePath = Join-Path $stateRoot 'state.json'
$expiryPath = Join-Path $stateRoot 'bilibili-qq-expiry.json'
$resultPath = Join-Path $stateRoot 'bilibili-qq-release-result.json'
$quarantineRoot = Join-Path $stateRoot 'quarantine'
$focusLockScript = Join-Path $stateRoot 'FocusLock.ps1'

$domainPattern = '(?i)(?:^|\.)(?:bilibili\.com|b23\.tv|bilivideo\.com|hdslb\.com|im\.qq\.com|pc\.qq\.com|dldir\.qq\.com|dldir1\.qq\.com|dldir1v6\.qq\.com|download\.imqq\.com)$'
$browserPatterns = @(
    '*://bilibili.com/*', '*://*.bilibili.com/*',
    '*://b23.tv/*', '*://*.b23.tv/*',
    '*://bilivideo.com/*', '*://*.bilivideo.com/*',
    '*://hdslb.com/*', '*://*.hdslb.com/*',
    '*://im.qq.com/*', '*://*.im.qq.com/*',
    '*://pc.qq.com/*', '*://dldir.qq.com/*', '*://*.dldir.qq.com/*',
    '*://dldir1.qq.com/*', '*://dldir1v6.qq.com/*', '*://download.imqq.com/*'
)
$clashRules = @(
    'DOMAIN-SUFFIX,bilibili.com,REJECT',
    'DOMAIN-SUFFIX,bilivideo.com,REJECT',
    'DOMAIN-SUFFIX,hdslb.com,REJECT',
    'DOMAIN-SUFFIX,b23.tv,REJECT',
    'DOMAIN,im.qq.com,REJECT',
    'DOMAIN,pc.qq.com,REJECT',
    'DOMAIN,dldir.qq.com,REJECT',
    'DOMAIN,dldir1.qq.com,REJECT',
    'DOMAIN,dldir1v6.qq.com,REJECT',
    'DOMAIN,download.imqq.com,REJECT'
)

function Save-Json([string]$Path, [object]$Value) {
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Remove-SelectedHosts {
    if (-not (Test-Path -LiteralPath $hostsPath)) { return }
    $raw = [IO.File]::ReadAllText($hostsPath)
    $kept = foreach ($line in ($raw -split '\r?\n')) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -ge 2 -and $parts[1] -match $domainPattern) { continue }
        $line
    }
    $updated = ($kept -join "`r`n").TrimEnd() + "`r`n"
    if ($updated -ne $raw) {
        [IO.File]::WriteAllText($hostsPath, $updated, [Text.UTF8Encoding]::new($false))
    }
}

function Remove-SelectedPolicies {
    if ($isFixture) {
        $items = if (Test-Path -LiteralPath $policyFixturePath) {
            @(Get-Content -Raw -LiteralPath $policyFixturePath -Encoding UTF8 | ConvertFrom-Json)
        } else { @() }
        Save-Json $policyFixturePath @($items | Where-Object { $browserPatterns -notcontains [string]$_.Value })
        return
    }
    foreach ($root in @(
        'HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist',
        'HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist'
    )) {
        if (-not (Test-Path -Path $root)) { continue }
        $properties = Get-ItemProperty -Path $root
        foreach ($property in $properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }) {
            if ($browserPatterns -contains [string]$property.Value) {
                Remove-ItemProperty -Path $root -Name $property.Name -ErrorAction Stop
            }
        }
    }
}

function Remove-SelectedClashRules {
    if (-not (Test-Path -LiteralPath $clashRoot)) { return }
    $paths = @(
        (Join-Path $clashRoot 'clash-verge.yaml'),
        (Join-Path $clashRoot 'clash-verge-check.yaml')
    )
    $profileRoot = Join-Path $clashRoot 'profiles'
    if (Test-Path -LiteralPath $profileRoot) {
        $paths += Get-ChildItem -LiteralPath $profileRoot -File -Filter '*.yaml' -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName
    }
    foreach ($path in $paths | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $raw = [IO.File]::ReadAllText($path)
        $updated = $raw
        foreach ($rule in $clashRules) {
            $updated = [regex]::Replace($updated, "(?m)^\s*-\s*$([regex]::Escape($rule))\s*\r?\n", '')
        }
        if ($updated -ne $raw) {
            [IO.File]::WriteAllText($path, $updated, [Text.UTF8Encoding]::new($false))
        }
    }
}

function Restore-QQImageBlocks([object]$State) {
    if ($isFixture) {
        $current = if (Test-Path -LiteralPath $ifeoFixturePath) {
            Get-Content -Raw -LiteralPath $ifeoFixturePath -Encoding UTF8 | ConvertFrom-Json
        } else { [pscustomobject]@{} }
        foreach ($backup in @($State.IfeoBackups)) {
            $property = $current.PSObject.Properties[$backup.Image]
            if ($backup.DebuggerExisted) {
                if ($property) { $property.Value = [string]$backup.DebuggerValue }
                else { $current | Add-Member -NotePropertyName $backup.Image -NotePropertyValue ([string]$backup.DebuggerValue) }
            } elseif ($property) {
                $current.PSObject.Properties.Remove($backup.Image)
            }
        }
        Save-Json $ifeoFixturePath $current
        return
    }
    foreach ($backup in @($State.IfeoBackups)) {
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$($backup.Image)"
        if (-not (Test-Path -Path $key)) { continue }
        if ($backup.DebuggerExisted) {
            New-ItemProperty -Path $key -Name Debugger -Value ([string]$backup.DebuggerValue) -PropertyType String -Force | Out-Null
        } else {
            Remove-ItemProperty -Path $key -Name Debugger -ErrorAction SilentlyContinue
        }
        if (-not $backup.KeyExisted) {
            $remaining = @(Get-Item -Path $key | Select-Object -ExpandProperty Property)
            if ($remaining.Count -eq 0) { Remove-Item -Path $key -Force -ErrorAction SilentlyContinue }
        }
    }
}

function Restore-QQQuarantine {
    if (-not (Test-Path -LiteralPath $quarantineRoot)) { return }
    Get-ChildItem -LiteralPath $quarantineRoot -File -Filter '*.origin.txt' -ErrorAction SilentlyContinue | ForEach-Object {
        $meta = $_
        $stored = $meta.FullName.Substring(0, $meta.FullName.Length - '.origin.txt'.Length)
        $original = (Get-Content -Raw -LiteralPath $meta.FullName -Encoding UTF8).Trim()
        if ((Test-Path -LiteralPath $stored) -and -not (Test-Path -LiteralPath $original)) {
            $parent = Split-Path -Parent $original
            if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Move-Item -LiteralPath $stored -Destination $original
            Remove-Item -LiteralPath $meta.FullName -Force
        }
    }
}

$succeeded = $false
try {
    $state = if (Test-Path -LiteralPath $statePath) {
        Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{ IfeoBackups = @() } }
    $expiry = if (Test-Path -LiteralPath $expiryPath) {
        Get-Content -Raw -LiteralPath $expiryPath -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{} }
    $expiry | Add-Member -NotePropertyName Status -NotePropertyValue 'Released' -Force
    $expiry | Add-Member -NotePropertyName ReleasedAt -NotePropertyValue ((Get-Date).ToString('o')) -Force
    $expiry | Add-Member -NotePropertyName Notify -NotePropertyValue $false -Force
    Save-Json $expiryPath $expiry

    Remove-SelectedHosts
    Remove-SelectedPolicies
    Remove-SelectedClashRules
    Restore-QQImageBlocks $state
    Restore-QQQuarantine

    if (-not $isFixture -and (Test-Path -LiteralPath $focusLockScript)) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $focusLockScript -Mode Reapply
        if ($LASTEXITCODE -ne 0) { throw "FocusLock reapply failed with exit code $LASTEXITCODE" }
    }
    if (-not $isFixture) {
        & ipconfig.exe /flushdns | Out-Null
        Get-Process -Name 'verge-mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }

    Save-Json $resultPath ([pscustomobject]@{
        Status = 'Released'
        ReleasedAt = (Get-Date).ToString('o')
        BilibiliReleased = $true
        QQReleased = $true
        NotificationSent = $false
    })
    $succeeded = $true
}
catch {
    Save-Json $resultPath ([pscustomobject]@{
        Status = 'Failed'
        FailedAt = (Get-Date).ToString('o')
        Error = $_.Exception.Message
        NotificationSent = $false
    })
    throw
}
finally {
    if ($succeeded -and -not $isFixture) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}
