[CmdletBinding()]
param(
    [ValidateRange(1, 30)][int]$Minutes = 5,
    [string]$ResultPath = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\temporary-unblock-qq-website-result.json'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges are required.' }

$repairTask = 'CodexFocusLock-Repair'
$restoreTask = 'CodexFocusLock-QQWebsiteRestore'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$restoreSource = Join-Path $PSScriptRoot 'Restore-QQWebsiteBlock.ps1'
$restoreInstalled = 'C:\ProgramData\CodexFocusLock\Restore-QQWebsiteBlock.ps1'
$clashRoot = 'C:\Users\Mashiroyes\AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev'
$restoreAt = (Get-Date).AddMinutes($Minutes)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path 'C:\ProgramData\MashiroBot\migration-backups\qq-website-release' $stamp
$qqDomainPattern = '(?i)(?:^|\.)(?:im\.qq\.com|pc\.qq\.com|dldir\.qq\.com|dldir1\.qq\.com|dldir1v6\.qq\.com|download\.imqq\.com)$'
$browserPatterns = @(
    '*://im.qq.com/*','*://*.im.qq.com/*','*://pc.qq.com/*',
    '*://dldir.qq.com/*','*://*.dldir.qq.com/*','*://dldir1.qq.com/*',
    '*://dldir1v6.qq.com/*','*://download.imqq.com/*'
)
$clashRules = @(
    'DOMAIN,im.qq.com,REJECT','DOMAIN,pc.qq.com,REJECT','DOMAIN,dldir.qq.com,REJECT',
    'DOMAIN,dldir1.qq.com,REJECT','DOMAIN,dldir1v6.qq.com,REJECT','DOMAIN,download.imqq.com,REJECT'
)
$changed = [System.Collections.Generic.List[string]]::new()

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
if (Test-Path -LiteralPath $hostsPath) { Copy-Item -LiteralPath $hostsPath -Destination (Join-Path $backupRoot 'hosts') -Force }
foreach ($file in @('C:\ProgramData\CodexFocusLock\FocusLock.ps1','C:\ProgramData\CodexFocusLock\state.json','C:\ProgramData\CodexFocusLock\bilibili-qq-expiry.json')) {
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backupRoot ([IO.Path]::GetFileName($file))) -Force }
}
$policySnapshot = foreach ($root in @('HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist','HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist')) {
    if (Test-Path -Path $root) {
        $properties = Get-ItemProperty -Path $root
        foreach ($property in $properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }) {
            [ordered]@{ Root=$root; Name=$property.Name; Value=[string]$property.Value }
        }
    }
}
@($policySnapshot) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupRoot 'browser-policies.json') -Encoding UTF8

Disable-ScheduledTask -TaskName $repairTask -ErrorAction SilentlyContinue | Out-Null

if (Test-Path -LiteralPath $hostsPath) {
    $raw = [IO.File]::ReadAllText($hostsPath)
    $kept = foreach ($line in ($raw -split '\r?\n')) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -ge 2 -and $parts[1] -match $qqDomainPattern) { continue }
        $line
    }
    $updated = ($kept -join "`r`n").TrimEnd() + "`r`n"
    if ($updated -ne $raw) { [IO.File]::WriteAllText($hostsPath, $updated, [Text.UTF8Encoding]::new($false)); $changed.Add($hostsPath) }
}

foreach ($root in @('HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist','HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist')) {
    if (-not (Test-Path -Path $root)) { continue }
    $properties = Get-ItemProperty -Path $root
    foreach ($property in $properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }) {
        if ($browserPatterns -contains [string]$property.Value) { Remove-ItemProperty -Path $root -Name $property.Name; $changed.Add("$root::$($property.Name)") }
    }
}

$clashFiles = @()
if (Test-Path -LiteralPath $clashRoot) {
    $clashFiles += Get-ChildItem -LiteralPath $clashRoot -File -Filter 'clash-verge*.yaml' -ErrorAction SilentlyContinue
    $profileRoot = Join-Path $clashRoot 'profiles'
    if (Test-Path -LiteralPath $profileRoot) { $clashFiles += Get-ChildItem -LiteralPath $profileRoot -File -Filter '*.yaml' -ErrorAction SilentlyContinue }
}
foreach ($file in $clashFiles | Select-Object -Unique) {
    $safeName = ($file.FullName -replace '[:\\/]', '_')
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backupRoot $safeName) -Force
    $raw = [IO.File]::ReadAllText($file.FullName)
    $updated = $raw
    foreach ($rule in $clashRules) { $updated = [regex]::Replace($updated, "(?m)^\s*-\s*$([regex]::Escape($rule))\s*\r?\n", '') }
    if ($updated -ne $raw) { [IO.File]::WriteAllText($file.FullName, $updated, [Text.UTF8Encoding]::new($false)); $changed.Add($file.FullName) }
}

Copy-Item -LiteralPath $restoreSource -Destination $restoreInstalled -Force
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ResultPath "{1}"' -f $restoreInstalled,('D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\restore-qq-website-result.json')
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At $restoreAt
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $restoreTask -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null

& ipconfig.exe /flushdns | Out-Null
Get-Process -Name 'verge-mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$remainingHosts = 0
foreach ($line in ([IO.File]::ReadAllText($hostsPath) -split '\r?\n')) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -match $qqDomainPattern) { $remainingHosts++ }
}
$remainingPolicies = 0
foreach ($root in @('HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist','HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist')) {
    if (Test-Path -Path $root) {
        $remainingPolicies += @((Get-ItemProperty -Path $root).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' -and $browserPatterns -contains [string]$_.Value }).Count
    }
}
$result = [ordered]@{
    Status='TemporarilyUnblocked'; StartedAt=(Get-Date).ToString('o'); RestoreAt=$restoreAt.ToString('o'); Minutes=$Minutes
    HostsClear=($remainingHosts -eq 0); BrowserPoliciesClear=($remainingPolicies -eq 0)
    BackupRoot=$backupRoot; RestoreTask=$restoreTask; Changed=@($changed)
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ResultPath -Encoding UTF8
if (-not $result.HostsClear -or -not $result.BrowserPoliciesClear) { throw 'QQ website release verification failed.' }
