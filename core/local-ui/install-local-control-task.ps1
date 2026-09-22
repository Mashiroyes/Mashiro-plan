[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskName = 'MashiroBot-Local-Control-Console'
$script = Join-Path $PSScriptRoot 'start-local-control.ps1'
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
[pscustomobject]@{ ok = $true; taskName = $taskName; state = (Get-ScheduledTask -TaskName $taskName).State } | ConvertTo-Json
