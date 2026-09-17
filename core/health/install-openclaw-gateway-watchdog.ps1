[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'OpenClaw Gateway Watchdog'
$WatchdogScript = Join-Path $PSScriptRoot 'watch-openclaw-gateway.ps1'
$StablePwshAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
$Pwsh = if (Test-Path -LiteralPath $StablePwshAlias -PathType Leaf) {
    $StablePwshAlias
} else {
    (Get-Command pwsh.exe -ErrorAction Stop).Source
}

if (-not (Test-Path -LiteralPath $WatchdogScript -PathType Leaf)) {
    throw "Gateway watchdog script is missing: $WatchdogScript"
}

$TaskUser = "$env:USERDOMAIN\$env:USERNAME"
$StartBoundary = (Get-Date).Date.AddMinutes(5).ToString('s')
$EscapedPwsh = [Security.SecurityElement]::Escape($Pwsh)
$EscapedScript = [Security.SecurityElement]::Escape($WatchdogScript)
$EscapedUser = [Security.SecurityElement]::Escape($TaskUser)
$TaskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Checks OpenClaw Gateway at logon and every six hours; starts it only when health fails.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$EscapedUser</UserId></LogonTrigger>
    <CalendarTrigger><StartBoundary>$StartBoundary</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay><Repetition><Interval>PT6H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$EscapedUser</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><AllowHardTerminate>true</AllowHardTerminate><ExecutionTimeLimit>PT2M</ExecutionTimeLimit><Enabled>true</Enabled><Hidden>true</Hidden></Settings>
  <Actions Context="Author"><Exec><Command>$EscapedPwsh</Command><Arguments>-NoProfile -ExecutionPolicy Bypass -File &quot;$EscapedScript&quot;</Arguments></Exec></Actions>
</Task>
"@

Register-ScheduledTask -TaskName $TaskName -Xml $TaskXml -Force | Out-Null
Write-Output "Installed scheduled task: $TaskName"
