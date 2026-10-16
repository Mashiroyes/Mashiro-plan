param(
    [ValidateSet('Install', 'Reapply', 'Scan', 'Remove', 'Status')]
    [string]$Mode = 'Status',
    [ValidateRange(1, 365)]
    [int]$DurationDays = 20
)

$ErrorActionPreference = 'Stop'

$lockName = 'CodexFocusLock'
$stateRoot = Join-Path $env:ProgramData $lockName
$installedScript = Join-Path $stateRoot 'FocusLock.ps1'
$statePath = Join-Path $stateRoot 'state.json'
$bilibiliQQExpiryPath = Join-Path $stateRoot 'bilibili-qq-expiry.json'
$qqAuthorizationPath = Join-Path $stateRoot 'qq-play-authorization.json'
$timeoutPromptSource = Join-Path $PSScriptRoot 'TimeoutReadingPrompt.ps1'
$timeoutPromptScript = Join-Path $stateRoot 'TimeoutReadingPrompt.ps1'
$qqCooldownSource = Join-Path $PSScriptRoot 'QQCooldownPrompt.ps1'
$qqCooldownScript = Join-Path $stateRoot 'QQCooldownPrompt.ps1'
$quarantineRoot = Join-Path $stateRoot 'quarantine'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$hostsStart = '# BEGIN CODEX FOCUS LOCK'
$hostsEnd = '# END CODEX FOCUS LOCK'
$clashStart = '# BEGIN CODEX FOCUS LOCK'
$clashEnd = '# END CODEX FOCUS LOCK'
$taskRepair = "$lockName-Repair"
$taskScan = "$lockName-QQScan"
$taskExpire = "$lockName-Expire"
$legacyBlockedDebugger = "$env:SystemRoot\System32\cmd.exe /d /c exit"
$qqCooldownDebugger = "`"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$qqCooldownScript`""

$bilibiliQQReleased = $false
$qqReleased = $false
$bilibiliQQExpiresAt = $null
$bilibiliTemporaryReleaseUntil = $null
$bilibiliTemporarilyReleased = $false
$qqInstallAuthorized = $false
$qqPlayAuthorized = $false
if (Test-Path -LiteralPath $bilibiliQQExpiryPath) {
    try {
        $bilibiliQQExpiryState = Get-Content -Raw -LiteralPath $bilibiliQQExpiryPath -Encoding UTF8 | ConvertFrom-Json
        if ($bilibiliQQExpiryState.ExpiresAt) {
            $bilibiliQQExpiresAt = [datetimeoffset]::Parse([string]$bilibiliQQExpiryState.ExpiresAt)
        }
        $bilibiliQQReleased = ([string]$bilibiliQQExpiryState.Status -eq 'Released') -or
            ($bilibiliQQExpiresAt -and [datetimeoffset]::Now -ge $bilibiliQQExpiresAt)
        $qqReleased = ([bool]$bilibiliQQExpiryState.QQReleased)
        if ($bilibiliQQExpiryState.BilibiliReleaseUntil) {
            $bilibiliTemporaryReleaseUntil = [datetimeoffset]::Parse([string]$bilibiliQQExpiryState.BilibiliReleaseUntil)
            $bilibiliTemporarilyReleased = [datetimeoffset]::Now -lt $bilibiliTemporaryReleaseUntil
        }
    }
    catch {
        $bilibiliQQReleased = $false
        $bilibiliQQExpiresAt = $null
        $bilibiliTemporaryReleaseUntil = $null
        $bilibiliTemporarilyReleased = $false
    }
}

# Missing, malformed, or expired authorization is deliberately treated as blocked.
if (Test-Path -LiteralPath $qqAuthorizationPath) {
    try {
        $qqAuthorization = Get-Content -Raw -LiteralPath $qqAuthorizationPath -Encoding UTF8 | ConvertFrom-Json
        $authorizationNow = [datetimeoffset]::UtcNow
        if ($qqAuthorization.QQInstallUntil) {
            $qqInstallAuthorized = $authorizationNow -lt [datetimeoffset]::Parse([string]$qqAuthorization.QQInstallUntil).ToUniversalTime()
        }
        if ($qqAuthorization.QQPlayUntil) {
            $qqPlayAuthorized = $authorizationNow -lt [datetimeoffset]::Parse([string]$qqAuthorization.QQPlayUntil).ToUniversalTime()
        }
    } catch {
        $qqInstallAuthorized = $false
        $qqPlayAuthorized = $false
    }
}

$bilibiliQQHosts = @(
    'bilibili.com',
    'www.bilibili.com',
    'm.bilibili.com',
    'space.bilibili.com',
    'search.bilibili.com',
    'account.bilibili.com',
    'passport.bilibili.com',
    'api.bilibili.com',
    'live.bilibili.com',
    'manga.bilibili.com',
    'game.bilibili.com',
    'link.bilibili.com',
    't.bilibili.com',
    'member.bilibili.com',
    'message.bilibili.com',
    'b23.tv',
    'www.b23.tv',
    'bilivideo.com',
    'www.bilivideo.com',
    'hdslb.com',
    'www.hdslb.com',
    'im.qq.com',
    'pc.qq.com',
    'dldir.qq.com',
    'dldir1.qq.com',
    'dldir1v6.qq.com',
    'download.imqq.com'
)

$bilibiliHosts = @($bilibiliQQHosts | Where-Object { $_ -match '(?i)(?:bilibili|b23|bilivideo|hdslb)' })
$qqHosts = @($bilibiliQQHosts | Where-Object { $_ -notmatch '(?i)(?:bilibili|b23|bilivideo|hdslb)' })

$permanentBlockedHosts = @(
    'hanime1.me',
    'www.hanime1.me',
    'missav.com',
    'www.missav.com'
)

$bilibiliQQBrowserPatterns = @(
    '*://bilibili.com/*',
    '*://*.bilibili.com/*',
    '*://b23.tv/*',
    '*://*.b23.tv/*',
    '*://bilivideo.com/*',
    '*://*.bilivideo.com/*',
    '*://hdslb.com/*',
    '*://*.hdslb.com/*',
    '*://im.qq.com/*',
    '*://*.im.qq.com/*',
    '*://pc.qq.com/*',
    '*://dldir.qq.com/*',
    '*://*.dldir.qq.com/*',
    '*://dldir1.qq.com/*',
    '*://dldir1v6.qq.com/*',
    '*://download.imqq.com/*'
)

$bilibiliBrowserPatterns = @($bilibiliQQBrowserPatterns | Where-Object { $_ -match '(?i)(?:bilibili|b23|bilivideo|hdslb)' })
$qqBrowserPatterns = @($bilibiliQQBrowserPatterns | Where-Object { $_ -notmatch '(?i)(?:bilibili|b23|bilivideo|hdslb)' })

$permanentBrowserPatterns = @(
    '*://hanime1.me/*',
    '*://*.hanime1.me/*',
    '*://missav.com/*',
    '*://*.missav.com/*'
)

$qqBlockedImages = @(
    'QQ.exe',
    'QQNT.exe',
    'TencentQQ.exe',
    'QQLauncher.exe',
    'QQScLauncher.exe',
    'QQProtect.exe',
    'QQSetup.exe',
    'QQInstaller.exe',
    'TIM.exe'
)
$qqInstallerImages = @('QQSetup.exe','QQInstaller.exe')
$qqClientImages = @($qqBlockedImages | Where-Object { $qqInstallerImages -notcontains $_ })
$proxyBlockedImages = @('openvpn.exe','wireguard.exe','windscribe.exe','nordvpn.exe','expressvpn.exe','protonvpn.exe','tor.exe','psiphon3.exe','outline-client.exe')

$bilibiliQQClashRules = @(
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

$bilibiliClashRules = @($bilibiliQQClashRules | Where-Object { $_ -match '(?i)(?:bilibili|b23|bilivideo|hdslb)' })
$qqClashRules = @($bilibiliQQClashRules | Where-Object { $_ -notmatch '(?i)(?:bilibili|b23|bilivideo|hdslb)' })

$permanentClashRules = @(
    'DOMAIN-SUFFIX,hanime1.me,REJECT',
    'DOMAIN-SUFFIX,missav.com,REJECT'
)

$familyDnsV4 = @('1.1.1.3', '1.0.0.3')
$familyDnsV6 = @('2606:4700:4700::1113', '2606:4700:4700::1003')
$secureDnsPolicyRoots = @(
    'HKLM:\SOFTWARE\Policies\Google\Chrome',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
)

$blockedHosts = @($permanentBlockedHosts)
$browserPatterns = @($permanentBrowserPatterns)
$blockedImages = @()
$clashRules = @($permanentClashRules)
if (-not $bilibiliQQReleased) {
    if (-not $bilibiliTemporarilyReleased) {
        $blockedHosts += $bilibiliHosts
        $browserPatterns += $bilibiliBrowserPatterns
        $clashRules += $bilibiliClashRules
    }
}
# QQ websites are permanent. Only signed, short-lived file authorization can
# release installer images; play authorization releases client images.
$blockedHosts += $qqHosts
$browserPatterns += $qqBrowserPatterns
$clashRules += $qqClashRules
if (-not $qqPlayAuthorized) { $blockedImages += $qqClientImages }
if (-not $qqInstallAuthorized) { $blockedImages += $qqInstallerImages }
$blockedImages += $proxyBlockedImages

$policyRoots = @(
    'HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist'
)

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
    if (-not (Test-Administrator)) {
        throw 'This action requires an elevated Administrator process.'
    }
}

function Get-State {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return $null
    }
    return Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json
}

function Save-State([object]$State) {
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Merge-PolicyEntries([object[]]$Existing, [object[]]$Added) {
    $byIdentity = [ordered]@{}
    foreach ($entry in @($Existing) + @($Added)) {
        if (-not $entry) { continue }
        $key = '{0}`0{1}`0{2}' -f ([string]$entry.Root), ([string]$entry.Name), ([string]$entry.Value)
        if (-not $byIdentity.Contains($key)) { $byIdentity[$key] = $entry }
    }
    return @($byIdentity.Values)
}

function Get-BlockedDebugger([string]$Image) {
    if ($qqClientImages -contains $Image) { return $qqCooldownDebugger }
    return $legacyBlockedDebugger
}

function Install-TimeoutPrompt([string]$UserName) {
    if (-not (Test-Path -LiteralPath $timeoutPromptSource -PathType Leaf)) { throw 'Timeout reading prompt source is missing.' }
    if (-not (Test-Path -LiteralPath $qqCooldownSource -PathType Leaf)) { throw 'QQ cooldown prompt source is missing.' }
    if ($timeoutPromptSource -ne $timeoutPromptScript) { Copy-Item -LiteralPath $timeoutPromptSource -Destination $timeoutPromptScript -Force }
    if ($qqCooldownSource -ne $qqCooldownScript) { Copy-Item -LiteralPath $qqCooldownSource -Destination $qqCooldownScript -Force }
    $existingTask = Get-ScheduledTask -TaskName 'CodexFocusLock-TimeoutReadingPrompt' -ErrorAction SilentlyContinue
    if ($existingTask -and [string]$existingTask.Actions[0].Arguments -match [regex]::Escape($timeoutPromptScript)) { return }
    & $timeoutPromptScript -Mode InstallTask -UserName $UserName -StateRoot $stateRoot | Out-Null
}

function Remove-MarkedBlock([string]$Raw, [string]$Start, [string]$End) {
    $escapedStart = [regex]::Escape($Start)
    $escapedEnd = [regex]::Escape($End)
    $pattern = "(?ms)\r?\n?[ \t]*$escapedStart[ \t]*\r?\n.*?[ \t]*$escapedEnd[ \t]*\r?\n?"
    return [regex]::Replace($Raw, $pattern, "`r`n")
}

function Set-HostsBlock {
    $raw = [IO.File]::ReadAllText($hostsPath)
    $clean = Remove-MarkedBlock $raw $hostsStart $hostsEnd
    $lines = @($hostsStart)
    $lines += $blockedHosts | ForEach-Object { "0.0.0.0`t$_" }
    $lines += $hostsEnd
    $updated = $clean.TrimEnd() + "`r`n`r`n" + ($lines -join "`r`n") + "`r`n"
    [IO.File]::WriteAllText($hostsPath, $updated, [Text.UTF8Encoding]::new($false))
    & ipconfig.exe /flushdns | Out-Null
}

function Remove-HostsBlock {
    if (-not (Test-Path -LiteralPath $hostsPath)) { return }
    $raw = [IO.File]::ReadAllText($hostsPath)
    $updated = (Remove-MarkedBlock $raw $hostsStart $hostsEnd).TrimEnd() + "`r`n"
    [IO.File]::WriteAllText($hostsPath, $updated, [Text.UTF8Encoding]::new($false))
    & ipconfig.exe /flushdns | Out-Null
}

function Add-BrowserPolicies {
    $added = [System.Collections.Generic.List[object]]::new()
    foreach ($root in $policyRoots) {
        if (-not (Test-Path -Path $root)) {
            New-Item -Path $root -Force | Out-Null
        }
        $existing = Get-ItemProperty -Path $root
        $existingValues = @($existing.PSObject.Properties |
            Where-Object { $_.Name -notmatch '^PS' } |
            ForEach-Object { [string]$_.Value })
        $usedNames = @($existing.PSObject.Properties |
            Where-Object { $_.Name -match '^\d+$' } |
            ForEach-Object { [int]$_.Name })
        $next = 9000
        foreach ($pattern in $browserPatterns) {
            if ($existingValues -contains $pattern) { continue }
            while ($usedNames -contains $next) { $next++ }
            $name = [string]$next
            New-ItemProperty -Path $root -Name $name -Value $pattern -PropertyType String -Force | Out-Null
            $added.Add([pscustomobject]@{ Root = $root; Name = $name; Value = $pattern })
            $usedNames += $next
            $next++
        }
    }
    return @($added)
}

function Restore-BrowserPolicies([object[]]$Entries) {
    foreach ($entry in @($Entries)) {
        if (Test-Path -Path $entry.Root) {
            $current = Get-ItemPropertyValue -Path $entry.Root -Name $entry.Name -ErrorAction SilentlyContinue
            if ($current -eq $entry.Value) {
                Remove-ItemProperty -Path $entry.Root -Name $entry.Name -ErrorAction SilentlyContinue
            }
        }
    }
}

function Get-EligibleDnsAdapters {
    if (-not (Get-Command Get-NetAdapter -ErrorAction SilentlyContinue)) { return @() }
    return @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
        Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch '(?i)virtual|hyper-v|wsl|clash|tap|tun' })
}

function Get-DnsBackup {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($adapter in @(Get-EligibleDnsAdapters)) {
        foreach ($family in @('IPv4','IPv6')) {
            $current = Get-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -AddressFamily $family -ErrorAction SilentlyContinue
            $result.Add([pscustomobject]@{
                InterfaceIndex = [int]$adapter.ifIndex
                AddressFamily = $family
                ServerAddresses = @($current.ServerAddresses)
            })
        }
    }
    return @($result)
}

function Set-AdultFilterDns {
    foreach ($adapter in @(Get-EligibleDnsAdapters)) {
        $servers = @($familyDnsV4)
        if ((Get-NetAdapterBinding -Name $adapter.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue).Enabled) { $servers += $familyDnsV6 }
        Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses $servers -ErrorAction Stop
    }
    & ipconfig.exe /flushdns | Out-Null
}

function Restore-DnsConfiguration([object[]]$Entries) {
    foreach ($group in @($Entries | Group-Object InterfaceIndex)) {
        $servers = @($group.Group | ForEach-Object { @($_.ServerAddresses) } | Where-Object { $_ })
        if ($servers.Count) {
            Set-DnsClientServerAddress -InterfaceIndex ([int]$group.Name) -ServerAddresses $servers -ErrorAction SilentlyContinue
        } else {
            Set-DnsClientServerAddress -InterfaceIndex ([int]$group.Name) -ResetServerAddresses -ErrorAction SilentlyContinue
        }
    }
    & ipconfig.exe /flushdns | Out-Null
}

function Get-SecureDnsPolicyBackup {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($root in $secureDnsPolicyRoots) {
        $existed = Test-Path -Path $root
        $policy = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
        $value = if ($policy -and $policy.PSObject.Properties['DnsOverHttpsMode']) { $policy.DnsOverHttpsMode } else { $null }
        $result.Add([pscustomobject]@{ Root=$root; KeyExisted=$existed; ValueExisted=($null -ne $value); Value=$value })
    }
    return @($result)
}

function Set-SecureDnsPolicies {
    foreach ($root in $secureDnsPolicyRoots) {
        if (-not (Test-Path -Path $root)) { New-Item -Path $root -Force | Out-Null }
        New-ItemProperty -Path $root -Name DnsOverHttpsMode -Value 'off' -PropertyType String -Force | Out-Null
    }
}

function Restore-SecureDnsPolicies([object[]]$Entries) {
    foreach ($entry in @($Entries)) {
        if ($entry.ValueExisted) {
            New-Item -Path $entry.Root -Force | Out-Null
            New-ItemProperty -Path $entry.Root -Name DnsOverHttpsMode -Value ([string]$entry.Value) -PropertyType String -Force | Out-Null
        } elseif (Test-Path -Path $entry.Root) {
            Remove-ItemProperty -Path $entry.Root -Name DnsOverHttpsMode -ErrorAction SilentlyContinue
        }
    }
}

function Set-ImageBlocks([switch]$CaptureBackup) {
    $backups = [System.Collections.Generic.List[object]]::new()
    foreach ($image in $blockedImages) {
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$image"
        if ($CaptureBackup) {
            $keyExisted = Test-Path -Path $key
            $debugger = Get-ItemPropertyValue -Path $key -Name Debugger -ErrorAction SilentlyContinue
            $backups.Add([pscustomobject]@{
                Image = $image
                KeyExisted = $keyExisted
                DebuggerExisted = ($null -ne $debugger)
                DebuggerValue = $debugger
            })
        }
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name Debugger -Value (Get-BlockedDebugger $image) -PropertyType String -Force | Out-Null
    }
    return @($backups)
}

function Sync-ImageBlocks([object]$State) {
    foreach ($image in @($qqBlockedImages + $proxyBlockedImages)) {
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$image"
        if ($blockedImages -contains $image) {
            New-Item -Path $key -Force | Out-Null
            New-ItemProperty -Path $key -Name Debugger -Value (Get-BlockedDebugger $image) -PropertyType String -Force | Out-Null
            continue
        }
        if (-not (Test-Path -Path $key)) { continue }
        $current = Get-ItemPropertyValue -Path $key -Name Debugger -ErrorAction SilentlyContinue
        if ($current -notin @($legacyBlockedDebugger, $qqCooldownDebugger)) { continue }
        $backup = @($State.IfeoBackups) | Where-Object { [string]$_.Image -eq $image } | Select-Object -First 1
        if ($backup -and $backup.DebuggerExisted) {
            New-ItemProperty -Path $key -Name Debugger -Value ([string]$backup.DebuggerValue) -PropertyType String -Force | Out-Null
        } else {
            Remove-ItemProperty -Path $key -Name Debugger -ErrorAction SilentlyContinue
            if ($backup -and -not $backup.KeyExisted) {
                $remaining = @(Get-ItemProperty -Path $key | Select-Object -ExpandProperty PSObject | Select-Object -ExpandProperty Properties | Where-Object Name -notmatch '^PS')
                if ($remaining.Count -eq 0) { Remove-Item -Path $key -Force -ErrorAction SilentlyContinue }
            }
        }
    }
}

function Restore-ImageBlocks([object[]]$Backups) {
    foreach ($backup in @($Backups)) {
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$($backup.Image)"
        if (-not (Test-Path -Path $key)) { continue }
        if ($backup.DebuggerExisted) {
            New-ItemProperty -Path $key -Name Debugger -Value ([string]$backup.DebuggerValue) -PropertyType String -Force | Out-Null
        } else {
            Remove-ItemProperty -Path $key -Name Debugger -ErrorAction SilentlyContinue
        }
        if (-not $backup.KeyExisted) {
            $remaining = @(Get-Item -Path $key | Select-Object -ExpandProperty Property)
            if ($remaining.Count -eq 0) {
                Remove-Item -Path $key -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Get-ClashRoot([object]$State) {
    $appDataRoot = if ($State -and $State.UserAppData) {
        [string]$State.UserAppData
    } else {
        $env:APPDATA
    }
    $candidate = Join-Path $appDataRoot 'io.github.clash-verge-rev.clash-verge-rev'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return $null
}

function Get-CurrentClashRuleProfile([string]$Root) {
    $profilesPath = Join-Path $Root 'profiles.yaml'
    if (-not (Test-Path -LiteralPath $profilesPath)) { return $null }
    $raw = [IO.File]::ReadAllText($profilesPath)
    $currentMatch = [regex]::Match($raw, '(?m)^current:\s*([^\s#]+)')
    if (-not $currentMatch.Success) { return $null }
    $uid = [regex]::Escape($currentMatch.Groups[1].Value)
    $itemMatch = [regex]::Match($raw, "(?ms)^- uid:\s*$uid\s*\r?\n(?<body>.*?)(?=^- uid:|\z)")
    if (-not $itemMatch.Success) { return $null }
    $ruleMatch = [regex]::Match($itemMatch.Groups['body'].Value, '(?m)^\s*rules:\s*([^\s#]+)')
    if (-not $ruleMatch.Success) { return $null }
    return Join-Path (Join-Path $Root 'profiles') ($ruleMatch.Groups[1].Value + '.yaml')
}

function Set-ClashRuleFile([string]$Path, [switch]$Generated) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $raw = [IO.File]::ReadAllText($Path)
    # Clash Verge may preserve surrounding YAML with LF while this script writes
    # the managed block with CRLF. Compare the block semantically first so a
    # harmless line-ending difference does not restart verge-mihomo every time
    # the QQ session watcher reapplies the focus policy.
    $existingPattern = "(?ms)[ \t]*$([regex]::Escape($clashStart))[ \t]*\r?\n(?<body>.*?)[ \t]*$([regex]::Escape($clashEnd))[ \t]*(?:\r?\n|$)"
    $existingMatch = [regex]::Match($raw, $existingPattern)
    if ($existingMatch.Success) {
        $existingRules = @(
            $existingMatch.Groups['body'].Value -split '\r?\n' |
                ForEach-Object { $_.Trim() } |
                Where-Object { $_ }
        )
        $expectedRules = @($clashRules | ForEach-Object { "- $_" })
        if (($existingRules -join "`n") -ceq ($expectedRules -join "`n")) {
            return $false
        }
    }
    $clean = Remove-MarkedBlock $raw $clashStart $clashEnd
    $ruleLines = $clashRules | ForEach-Object { "- $_" }
    $block = @($clashStart) + $ruleLines + @($clashEnd)

    if ($Generated) {
        if ($clean -notmatch '(?m)^rules:\s*$') { return $false }
        $updated = [regex]::Replace(
            $clean,
            '(?m)^rules:\s*$',
            "rules:`r`n" + ($block -join "`r`n"),
            1
        )
    } else {
        $indented = $block | ForEach-Object { "  $_" }
        if ($clean -match '(?m)^prepend:\s*\[\]\s*$') {
            $updated = [regex]::Replace(
                $clean,
                '(?m)^prepend:\s*\[\]\s*$',
                "prepend:`r`n" + ($indented -join "`r`n"),
                1
            )
        } elseif ($clean -match '(?m)^prepend:\s*$') {
            $updated = [regex]::Replace(
                $clean,
                '(?m)^prepend:\s*$',
                "prepend:`r`n" + ($indented -join "`r`n"),
                1
            )
        } else {
            $updated = "prepend:`r`n" + ($indented -join "`r`n") + "`r`n`r`n" + $clean.TrimStart()
        }
    }

    if ($updated -ne $raw) {
        [IO.File]::WriteAllText($Path, $updated, [Text.UTF8Encoding]::new($false))
        return $true
    }
    return $false
}

function Set-ClashBlocks([object]$State) {
    $root = Get-ClashRoot $State
    if (-not $root) { return $false }
    $changed = $false
    $ruleProfile = Get-CurrentClashRuleProfile $root
    if ($ruleProfile) {
        $changed = (Set-ClashRuleFile $ruleProfile) -or $changed
    }
    foreach ($name in @('clash-verge.yaml', 'clash-verge-check.yaml')) {
        $path = Join-Path $root $name
        $changed = (Set-ClashRuleFile $path -Generated) -or $changed
    }
    if ($changed) {
        Get-Process -Name 'verge-mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    return $changed
}

function Remove-ClashBlocks([object]$State) {
    $root = Get-ClashRoot $State
    if (-not $root) { return }
    $paths = @(
        (Join-Path $root 'clash-verge.yaml'),
        (Join-Path $root 'clash-verge-check.yaml')
    )
    $profileRoot = Join-Path $root 'profiles'
    if (Test-Path -LiteralPath $profileRoot) {
        $paths += Get-ChildItem -LiteralPath $profileRoot -File -Filter '*.yaml' | Select-Object -ExpandProperty FullName
    }
    $changed = $false
    foreach ($path in $paths | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $raw = [IO.File]::ReadAllText($path)
        if ($raw -notmatch [regex]::Escape($clashStart)) { continue }
        $updated = Remove-MarkedBlock $raw $clashStart $clashEnd
        $updated = [regex]::Replace($updated, '(?m)^prepend:\s*(?:\r?\n){2,}', "prepend: []`r`n`r`n")
        [IO.File]::WriteAllText($path, $updated, [Text.UTF8Encoding]::new($false))
        $changed = $true
    }
    if ($changed) {
        Get-Process -Name 'verge-mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}

function Stop-QQProcesses {
    $baseNames = $blockedImages | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_) }
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $baseNames -contains $_.ProcessName } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Move-QQInstallers([object]$State) {
    New-Item -ItemType Directory -Path $quarantineRoot -Force | Out-Null
    $userProfile = if ($State -and $State.UserProfile) {
        [string]$State.UserProfile
    } else {
        $env:USERPROFILE
    }
    $desktopPath = if ($State -and $State.DesktopPath) {
        [string]$State.DesktopPath
    } else {
        [Environment]::GetFolderPath('Desktop')
    }
    $roots = @(
        (Join-Path $userProfile 'Downloads'),
        $desktopPath
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
    $pattern = '^(QQ|QQNT|TencentQQ|QQInstaller|QQSetup|TIM)(?=[0-9._ -]|$).*\.(exe|msi)$'
    foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match $pattern } |
            ForEach-Object {
                $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
                $destination = Join-Path $quarantineRoot ($stamp + '__' + $_.Name)
                $metaPath = $destination + '.origin.txt'
                Set-Content -LiteralPath $metaPath -Value $_.FullName -Encoding UTF8
                Move-Item -LiteralPath $_.FullName -Destination $destination -Force
            }
    }
}

function Restore-Quarantine {
    if (-not (Test-Path -LiteralPath $quarantineRoot)) { return }
    Get-ChildItem -LiteralPath $quarantineRoot -File -Filter '*.origin.txt' | ForEach-Object {
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

function Register-LockTasks([datetime]$ExpiresAt) {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $duration = $ExpiresAt - (Get-Date)
    if ($duration.TotalMinutes -lt 1) { $duration = New-TimeSpan -Minutes 1 }
    $permanentSchedule = $duration.TotalDays -gt 365

    $repairAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installedScript`" -Mode Reapply"
    $repairTrigger = if ($permanentSchedule) {
        New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
    } else {
        New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ($duration + (New-TimeSpan -Hours 1))
    }
    Register-ScheduledTask -TaskName $taskRepair -Action $repairAction -Trigger $repairTrigger -Principal $principal -Settings $settings -Force | Out-Null

    $scanAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installedScript`" -Mode Scan"
    $scanTrigger = if ($permanentSchedule) {
        New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    } else {
        New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ($duration + (New-TimeSpan -Hours 1))
    }
    Register-ScheduledTask -TaskName $taskScan -Action $scanAction -Trigger $scanTrigger -Principal $principal -Settings $settings -Force | Out-Null

    if (-not $permanentSchedule) {
        $expireAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installedScript`" -Mode Remove"
        $expireTrigger = New-ScheduledTaskTrigger -Once -At $ExpiresAt
        Register-ScheduledTask -TaskName $taskExpire -Action $expireAction -Trigger $expireTrigger -Principal $principal -Settings $settings -Force | Out-Null
    }
}

function Remove-LockTasks {
    foreach ($name in @($taskRepair, $taskScan, $taskExpire)) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    }
}

function Invoke-Install {
    Assert-Administrator
    if (Test-Path -LiteralPath $statePath) {
        throw "A focus lock is already installed. Remove it before installing a new one."
    }

    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $quarantineRoot -Force | Out-Null
    if ($PSCommandPath -ne $installedScript) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force
    }

    Install-TimeoutPrompt $env:USERNAME

    $installedAt = Get-Date
    $expiresAt = $installedAt.AddDays($DurationDays)
    $dnsBackups = Get-DnsBackup
    $secureDnsPolicyBackups = Get-SecureDnsPolicyBackup
    $policyEntries = Add-BrowserPolicies
    $ifeoBackups = Set-ImageBlocks -CaptureBackup
    Set-HostsBlock
    [void](Set-ClashBlocks $null)
    Set-SecureDnsPolicies
    Set-AdultFilterDns
    Stop-QQProcesses

    $state = [pscustomobject]@{
        InstalledAt = $installedAt.ToString('o')
        ExpiresAt = $expiresAt.ToString('o')
        DurationDays = $DurationDays
        UserName = $env:USERNAME
        UserProfile = $env:USERPROFILE
        UserAppData = $env:APPDATA
        DesktopPath = [Environment]::GetFolderPath('Desktop')
        PolicyEntries = @($policyEntries)
        IfeoBackups = @($ifeoBackups)
        DnsBackups = @($dnsBackups)
        SecureDnsPolicyBackups = @($secureDnsPolicyBackups)
    }
    Save-State $state
    Register-LockTasks $expiresAt
    [pscustomobject]@{
        Status = 'Installed'
        InstalledAt = $installedAt.ToString('yyyy-MM-dd HH:mm:ss')
        ExpiresAt = $expiresAt.ToString('yyyy-MM-dd HH:mm:ss')
        DurationDays = $DurationDays
    } | ConvertTo-Json
}

function Invoke-Reapply {
    Assert-Administrator
    $state = Get-State
    if (-not $state) { return }
    $isPermanent = ($state.Permanent -eq $true) -or ([string]$state.DurationDays -eq 'Permanent')
    if (-not $isPermanent -and (Get-Date) -ge [datetime]$state.ExpiresAt) {
        Invoke-Remove
        return
    }
    Set-HostsBlock
    if (-not $state.PSObject.Properties['DnsBackups']) {
        $state | Add-Member -NotePropertyName DnsBackups -NotePropertyValue @(Get-DnsBackup)
    }
    if (-not $state.PSObject.Properties['SecureDnsPolicyBackups']) {
        $state | Add-Member -NotePropertyName SecureDnsPolicyBackups -NotePropertyValue @(Get-SecureDnsPolicyBackup)
    }
    $newPolicyEntries = @(Add-BrowserPolicies)
    $state.PolicyEntries = @(Merge-PolicyEntries @($state.PolicyEntries) $newPolicyEntries)
    foreach ($image in $proxyBlockedImages) {
        if (@($state.IfeoBackups | Where-Object Image -eq $image).Count) { continue }
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$image"
        $ifeo = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        $debugger = if ($ifeo -and $ifeo.PSObject.Properties['Debugger']) { $ifeo.Debugger } else { $null }
        $state.IfeoBackups = @($state.IfeoBackups) + [pscustomobject]@{ Image=$image; KeyExisted=(Test-Path $key); DebuggerExisted=($null -ne $debugger); DebuggerValue=$debugger }
    }
    Set-SecureDnsPolicies
    Set-AdultFilterDns
    if ($isPermanent) {
        $state.Permanent = $true
        $state.DurationDays = 'Permanent'
        $state.ExpiresAt = '2099-12-31T23:59:59+08:00'
    }
    Save-State $state
    if (-not (Get-ScheduledTask -TaskName $taskRepair -ErrorAction SilentlyContinue) -or
        -not (Get-ScheduledTask -TaskName $taskScan -ErrorAction SilentlyContinue)) {
        Register-LockTasks ([datetime]$state.ExpiresAt)
    }
    Install-TimeoutPrompt ([string]$state.UserName)
    Sync-ImageBlocks $state
    [void](Set-ClashBlocks $state)
    Stop-QQProcesses
}

function Invoke-Scan {
    Assert-Administrator
    $state = Get-State
    if (-not $state) { return }
    $isPermanent = ($state.Permanent -eq $true) -or ([string]$state.DurationDays -eq 'Permanent')
    if (-not $isPermanent -and (Get-Date) -ge [datetime]$state.ExpiresAt) {
        Invoke-Remove
        return
    }
    Stop-QQProcesses
}

function Invoke-Remove {
    Assert-Administrator
    $state = Get-State
    Remove-HostsBlock
    Remove-ClashBlocks $state
    if ($state) {
        Restore-BrowserPolicies @($state.PolicyEntries)
        Restore-ImageBlocks @($state.IfeoBackups)
        Restore-SecureDnsPolicies @($state.SecureDnsPolicyBackups)
        Restore-DnsConfiguration @($state.DnsBackups)
    }
    Restore-Quarantine
    Remove-LockTasks
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}

function Get-Status {
    $state = Get-State
    $tasks = Get-ScheduledTask -TaskName "$lockName-*" -ErrorAction SilentlyContinue |
        Select-Object TaskName, State
    $hostsManaged = $false
    if (Test-Path -LiteralPath $hostsPath) {
        $hostsManaged = [IO.File]::ReadAllText($hostsPath).Contains($hostsStart)
    }
    $dnsDetails = @(Get-EligibleDnsAdapters | ForEach-Object {
        $addresses = @(Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ErrorAction SilentlyContinue | ForEach-Object ServerAddresses)
        [pscustomobject]@{ InterfaceIndex=$_.ifIndex; Name=$_.Name; ServerAddresses=$addresses; Managed=(($familyDnsV4 | Where-Object { $addresses -notcontains $_ }).Count -eq 0) }
    })
    $secureDnsDisabled = (($secureDnsPolicyRoots | Where-Object {
        $policy = Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue
        (-not $policy) -or ([string]$policy.DnsOverHttpsMode -ne 'off')
    }).Count -eq 0)
    [pscustomobject]@{
        Installed = ($null -ne $state)
        InstalledAt = if ($state) { $state.InstalledAt } else { $null }
        ExpiresAt = if ($state) { $state.ExpiresAt } else { $null }
        BilibiliQQExpiresAt = if ($bilibiliQQExpiresAt) { $bilibiliQQExpiresAt.ToString('o') } else { $null }
        BilibiliQQReleased = $bilibiliQQReleased
        BilibiliTemporaryReleaseUntil = if ($bilibiliTemporaryReleaseUntil) { $bilibiliTemporaryReleaseUntil.ToString('o') } else { $null }
        BilibiliTemporarilyReleased = $bilibiliTemporarilyReleased
        HostsManaged = $hostsManaged
        AdultDnsManaged = (($dnsDetails | Where-Object { -not $_.Managed }).Count -eq 0 -and $dnsDetails.Count -gt 0)
        DnsAdapters = $dnsDetails
        SecureDnsDisabled = $secureDnsDisabled
        Tasks = @($tasks)
        QuarantineCount = if (Test-Path -LiteralPath $quarantineRoot) {
            @(Get-ChildItem -LiteralPath $quarantineRoot -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notlike '*.origin.txt' }).Count
        } else { 0 }
    } | ConvertTo-Json -Depth 5
}

switch ($Mode) {
    'Install' { Invoke-Install }
    'Reapply' { Invoke-Reapply }
    'Scan' { Invoke-Scan }
    'Remove' { Invoke-Remove }
    'Status' { Get-Status }
}
