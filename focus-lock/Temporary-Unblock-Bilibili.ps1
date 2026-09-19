param(
    [ValidateRange(1, 240)]
    [int]$Minutes = 30
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

$repairTask = 'CodexFocusLock-Repair'
$restoreTask = 'CodexFocusLock-BilibiliRestore'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$restoreSource = Join-Path $PSScriptRoot 'Restore-BilibiliBlock.ps1'
$restoreInstalled = 'C:\ProgramData\CodexFocusLock\Restore-BilibiliBlock.ps1'
$resultPath = Join-Path $PSScriptRoot 'temporary-unblock-bilibili-result.json'
$clashRoot = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
$restoreAt = (Get-Date).AddMinutes($Minutes)

$domainPattern = '(?i)(?:^|\.)(?:bilibili\.com|b23\.tv|bilivideo\.com|hdslb\.com)$'
$browserPatterns = @(
    '*://bilibili.com/*', '*://*.bilibili.com/*',
    '*://b23.tv/*', '*://*.b23.tv/*',
    '*://bilivideo.com/*', '*://*.bilivideo.com/*',
    '*://hdslb.com/*', '*://*.hdslb.com/*'
)
$clashRules = @(
    'DOMAIN-SUFFIX,bilibili.com,REJECT',
    'DOMAIN-SUFFIX,bilivideo.com,REJECT',
    'DOMAIN-SUFFIX,hdslb.com,REJECT',
    'DOMAIN-SUFFIX,b23.tv,REJECT'
)
$changed = [System.Collections.Generic.List[string]]::new()

Disable-ScheduledTask -TaskName $repairTask -ErrorAction SilentlyContinue | Out-Null

if (Test-Path -LiteralPath $hostsPath) {
    $raw = [IO.File]::ReadAllText($hostsPath)
    $kept = foreach ($line in ($raw -split '\r?\n')) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -ge 2 -and $parts[1] -match $domainPattern) { continue }
        $line
    }
    $updated = ($kept -join "`r`n").TrimEnd() + "`r`n"
    if ($updated -ne $raw) {
        [IO.File]::WriteAllText($hostsPath, $updated, [Text.UTF8Encoding]::new($false))
        $changed.Add($hostsPath)
    }
}

foreach ($root in @(
    'HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist'
)) {
    if (-not (Test-Path -Path $root)) { continue }
    $properties = Get-ItemProperty -Path $root
    foreach ($property in $properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }) {
        if ($browserPatterns -contains [string]$property.Value) {
            Remove-ItemProperty -Path $root -Name $property.Name
            $changed.Add("$root::$($property.Name)")
        }
    }
}

$clashPaths = @()
if (Test-Path -LiteralPath $clashRoot) {
    $clashPaths += Get-ChildItem -LiteralPath $clashRoot -File -Filter 'clash-verge*.yaml' -ErrorAction SilentlyContinue
    $profileRoot = Join-Path $clashRoot 'profiles'
    if (Test-Path -LiteralPath $profileRoot) {
        $clashPaths += Get-ChildItem -LiteralPath $profileRoot -File -Filter '*.yaml' -ErrorAction SilentlyContinue
    }
}
foreach ($file in $clashPaths | Select-Object -Unique) {
    $raw = [IO.File]::ReadAllText($file.FullName)
    $updated = $raw
    foreach ($rule in $clashRules) {
        $updated = [regex]::Replace($updated, "(?m)^\s*-\s*$([regex]::Escape($rule))\s*\r?\n", '')
    }
    if ($updated -ne $raw) {
        [IO.File]::WriteAllText($file.FullName, $updated, [Text.UTF8Encoding]::new($false))
        $changed.Add($file.FullName)
    }
}

Copy-Item -LiteralPath $restoreSource -Destination $restoreInstalled -Force
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$restoreInstalled`""
$taskTrigger = New-ScheduledTaskTrigger -Once -At $restoreAt
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $restoreTask -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null

& ipconfig.exe /flushdns | Out-Null
Get-Process -Name 'verge-mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
    Status = 'TemporarilyUnblocked'
    StartedAt = (Get-Date).ToString('o')
    RestoreAt = $restoreAt.ToString('o')
    Minutes = $Minutes
    Changed = @($changed)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
