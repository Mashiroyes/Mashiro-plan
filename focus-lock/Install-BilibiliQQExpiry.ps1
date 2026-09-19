$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

$sourceRoot = Split-Path -Parent $PSCommandPath
$stateRoot = 'C:\ProgramData\CodexFocusLock'
$sourceFocusLock = Join-Path $sourceRoot 'FocusLock.ps1'
$sourceRelease = Join-Path $sourceRoot 'Release-BilibiliQQ.ps1'
$installedFocusLock = Join-Path $stateRoot 'FocusLock.ps1'
$installedRelease = Join-Path $stateRoot 'Release-BilibiliQQ.ps1'
$expiryPath = Join-Path $stateRoot 'bilibili-qq-expiry.json'
$resultPath = Join-Path $stateRoot 'bilibili-qq-expiry-install-result.json'
$taskName = 'CodexFocusLock-BilibiliQQExpire'
$expiresAt = [datetimeoffset]'2026-08-18T20:08:00+08:00'

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
if (Test-Path -LiteralPath $installedFocusLock) {
    $backup = Join-Path $stateRoot ('FocusLock.ps1.bak-before-bilibili-qq-expiry-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item -LiteralPath $installedFocusLock -Destination $backup -Force
}
Copy-Item -LiteralPath $sourceFocusLock -Destination $installedFocusLock -Force
Copy-Item -LiteralPath $sourceRelease -Destination $installedRelease -Force

[pscustomobject]@{
    ExpiresAt = $expiresAt.ToString('o')
    Status = 'Scheduled'
    Notify = $false
    Targets = @('Bilibili','QQ')
    Preserve = @('hanime1.me','UnrelatedRules')
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $expiryPath -Encoding UTF8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installedRelease`""
$trigger = New-ScheduledTaskTrigger -Once -At $expiresAt.LocalDateTime
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null

$sourceFocusHash = (Get-FileHash -LiteralPath $sourceFocusLock -Algorithm SHA256).Hash
$installedFocusHash = (Get-FileHash -LiteralPath $installedFocusLock -Algorithm SHA256).Hash
$sourceReleaseHash = (Get-FileHash -LiteralPath $sourceRelease -Algorithm SHA256).Hash
$installedReleaseHash = (Get-FileHash -LiteralPath $installedRelease -Algorithm SHA256).Hash
if ($sourceFocusHash -ne $installedFocusHash -or $sourceReleaseHash -ne $installedReleaseHash) {
    throw 'Installed script hash verification failed.'
}

[pscustomobject]@{
    Status = 'Installed'
    InstalledAt = (Get-Date).ToString('o')
    ExpiresAt = $expiresAt.ToString('o')
    TaskName = $taskName
    Notify = $false
    FocusLockSHA256 = $installedFocusHash
    ReleaseSHA256 = $installedReleaseHash
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding UTF8
