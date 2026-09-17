param(
    [Parameter(Mandatory = $true)][ValidateSet('Schedule', 'Remove')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$TaskPayloadBase64,
    [Parameter(Mandatory = $true)][string]$SqlitePath
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

function Decode-Payload {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TaskPayloadBase64))
    return $json | ConvertFrom-Json -DateKind String
}

function Remove-TaskNames($Payload) {
    foreach ($name in @($Payload.reminderTaskName, $Payload.forceTaskName)) {
        if ($name -and $name -like 'OpenClaw-GameTimer-*') {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
}

$payload = Decode-Payload
if ($Mode -eq 'Remove') {
    Remove-TaskNames $payload
    [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
    exit 0
}

$workerRoot = Join-Path $env:LOCALAPPDATA 'MashiroBot\game-timer\workers'
$worker = Join-Path $workerRoot 'game-timer-worker-v1.ps1'
$dbHelper = Join-Path $workerRoot 'game-timer-db-v1.mjs'
[IO.Directory]::CreateDirectory($workerRoot) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'game-timer-worker-v1.ps1') -Destination $worker -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'game-timer-db-v1.mjs') -Destination $dbHelper -Force

$shortId = ([string]$payload.id).Replace('-', '').Substring(0, 12)
$reminderTaskName = "OpenClaw-GameTimer-Reminder-$shortId"
$forceTaskName = "OpenClaw-GameTimer-Force-$shortId"
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -WakeToRun `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
    -Disable
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $pwshPath -PathType Leaf)) {
    throw "Unable to resolve the current PowerShell executable: $pwshPath"
}

function Register-TimerTask([string]$Name, [string]$WorkerMode, [string]$AtValue) {
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode {1} -TaskId "{2}" -SqlitePath "{3}" -ScheduledTaskName "{4}"' -f $worker, $WorkerMode, $payload.id, $SqlitePath, $Name
    if ([bool]$payload.dryRun) { $arguments += ' -DryRun' }
    $action = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments
    $at = [DateTimeOffset]::Parse($AtValue)
    $trigger = New-ScheduledTaskTrigger -Once -At $at.LocalDateTime
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $Name -InputObject $definition -Force | Out-Null
    Enable-ScheduledTask -TaskName $Name | Out-Null
}

function Assert-RegisteredTime([string]$TaskName, [string]$ExpectedValue) {
    [xml]$taskXml = Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $saved = [DateTime]::Parse([string]$taskXml.Task.Triggers.TimeTrigger.StartBoundary)
    $expected = [DateTimeOffset]::Parse($ExpectedValue).LocalDateTime
    $difference = [Math]::Abs(($saved - $expected).TotalSeconds)
    if ($difference -gt 2) {
        throw "Scheduled task time mismatch: $TaskName expected=$($expected.ToString('o')) saved=$($saved.ToString('o'))"
    }
}

$created = [ordered]@{ reminderTaskName = $reminderTaskName; forceTaskName = $forceTaskName }
try {
    Register-TimerTask $reminderTaskName 'Reminder' ([string]$payload.reminderAt)
    Register-TimerTask $forceTaskName 'Force' ([string]$payload.forceAt)
    Assert-RegisteredTime $reminderTaskName ([string]$payload.reminderAt)
    Assert-RegisteredTime $forceTaskName ([string]$payload.forceAt)
    [pscustomobject]$created | ConvertTo-Json -Compress
} catch {
    Remove-TaskNames ([pscustomobject]$created)
    throw
}
