$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

$root = Split-Path -Parent $PSCommandPath
$unblock = Join-Path $root 'Unblock-Hanime1.ps1'
$restore = Join-Path $root 'Restore-Hanime1AfterTemporaryUnblock.ps1'
$taskName = 'CodexFocusLock-HanimeRestore'
$restoreAt = (Get-Date).AddHours(1)

Disable-ScheduledTask -TaskName 'CodexFocusLock-Repair' -ErrorAction SilentlyContinue | Out-Null
try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $unblock
    if ($LASTEXITCODE -ne 0) { throw "Temporary unblock failed with exit code $LASTEXITCODE" }
}
catch {
    Enable-ScheduledTask -TaskName 'CodexFocusLock-Repair' -ErrorAction SilentlyContinue | Out-Null
    throw
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$restore`""
$trigger = New-ScheduledTaskTrigger -Once -At $restoreAt
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null

[pscustomobject]@{
    Status = 'Scheduled'
    RestoreAt = $restoreAt.ToString('o')
    TaskName = $taskName
    NotificationSent = $false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'temporary-unblock-hanime1-result.json') -Encoding UTF8
