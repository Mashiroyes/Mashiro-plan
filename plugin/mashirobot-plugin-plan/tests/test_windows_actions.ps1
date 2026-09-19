[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$pluginRoot = Split-Path -Parent $PSScriptRoot
$windowsRoot = Join-Path $pluginRoot 'windows'
$entry = Join-Path $windowsRoot 'routine-reminder.ps1'
$planner = Join-Path $pluginRoot 'planner\planner.py'
$python = (Get-Command python.exe -ErrorAction Stop).Source
$tempRoot = Join-Path $env:TEMP ('mashirobot-windows-test-' + [Guid]::NewGuid().ToString('N'))
$env:OPENCLAW_PLANNER_DB_PATH = Join-Path $tempRoot 'planner.sqlite'
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-Entry([string[]]$Arguments, [bool]$ShouldFail = $false) {
    $output = & pwsh -NoProfile -File $entry @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($ShouldFail) {
        Assert-True ($exitCode -ne 0) "Expected failure: $($Arguments -join ' ')"
    } else {
        Assert-True ($exitCode -eq 0) "Command failed: $($Arguments -join ' ')`n$($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine)
}

try {
    foreach ($name in @(
        'routine-reminder.ps1','plan-reminder-worker.ps1','manage-plan.ps1',
        'reminder-common.ps1','routine-common.ps1','wakeup-common.ps1',
        'cloudmusic-playback.ps1','check-disk-space.ps1'
    )) {
        Assert-True (Test-Path -LiteralPath (Join-Path $windowsRoot $name)) "Missing migrated Windows action: $name"
    }

    $allSource = (Get-ChildItem -LiteralPath $windowsRoot -Filter '*.ps1' | ForEach-Object {
        Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
    }) -join "`n"
    Assert-True (-not $allSource.Contains('\plan\script\')) 'Migrated scripts still contain the old plan\script root.'
    Assert-True ($allSource.Contains('$PSCommandPath')) 'Unified task producers do not derive their action from the plugin entrypoint.'
    Assert-True ($allSource.Contains('get-plugin-state')) 'SQLite plugin state read command is missing.'
    Assert-True ($allSource.Contains('set-plugin-state')) 'SQLite plugin state write command is missing.'
    Assert-True (-not $allSource.Contains('OPENCLAW_ROUTINE_STATE_PATH')) 'Routine JSON state override survived migration.'
    Assert-True (-not $allSource.Contains('OPENCLAW_WAKEUP_STATE_PATH')) 'Wakeup JSON state override survived migration.'

    Invoke-Entry @('-Action','SendHabit') $true | Out-Null
    Invoke-Entry @('-Action','SetWakeup') $true | Out-Null
    Invoke-Entry @('-Action','RunWakeup') $true | Out-Null
    Invoke-Entry @('-Action','SetGeneralReminder') $true | Out-Null
    Invoke-Entry @('-Action','RunGeneralReminder') $true | Out-Null

    $shower = Invoke-Entry @('-Action','Shower')
    Assert-True ($shower -eq '真白，该洗澡啦。洗完就准备打卡和睡觉。') 'Shower text changed.'
    $future = [DateTimeOffset]::Now.AddDays(30).ToString('yyyy-MM-ddTHH:mm:sszzz')
    $startNight = Invoke-Entry @('-Action','StartNight','-DryRun')
    Assert-True ($startNight -eq '真白，先确认单词有没有打卡。打完后回复“已打卡”，睡下后回复“已睡觉”。') 'StartNight text changed.'
    $shanghaiNow = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'China Standard Time')
    $routineDate = if ($shanghaiNow.Hour -lt 6) { $shanghaiNow.AddDays(-1).ToString('yyyy-MM-dd') } else { $shanghaiNow.ToString('yyyy-MM-dd') }
    $routineRead = & $python $planner get-plugin-state --plugin-id mashirobot-plugin-plan --state-key ('night:' + $routineDate) | ConvertFrom-Json -AsHashtable
    Assert-True ([bool]$routineRead.found) 'StartNight did not write isolated SQLite routine state.'

    . (Join-Path $windowsRoot 'wakeup-common.ps1')
    $wakeupTestState = @{
        active = $false; startAt = $future; intervalMinutes = 10; stopReply = '已起床'
        windowsTaskName = $null; triggeredAt = $null; completedAt = $null
        lastReminderAt = $null; lastError = $null; updatedAt = $future
    }
    Write-WakeupState -State $wakeupTestState
    $wakeupRead = Read-WakeupState
    Assert-True ($null -ne $wakeupRead -and [int]$wakeupRead.intervalMinutes -eq 10) 'Wakeup SQLite state round-trip failed.'

    $fixed = (Invoke-Entry @('-Action','InstallFixed','-DryRun')) | ConvertFrom-Json
    Assert-True (@($fixed).Count -eq 2) 'InstallFixed did not produce two definitions.'
    foreach ($item in @($fixed)) {
        Assert-True ([bool]$item.WakeToRun) "WakeToRun missing for $($item.TaskName)."
        Assert-True ([bool]$item.StartWhenAvailable) "StartWhenAvailable missing for $($item.TaskName)."
        Assert-True ([string]$item.Action -match '\\plan\\plugin\\mashirobot-plugin-plan\\windows\\routine-reminder\.ps1') "Fixed task uses the wrong root: $($item.Action)"
    }

    $planPayload = @{
        date = '2099-01-01'
        rawText = "计划`n09:00 - 10:00 背单词"
        items = @(@{ startTime = '09:00'; endTime = '10:00'; title = '背单词' })
    } | ConvertTo-Json -Compress -Depth 6
    $planPayload64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($planPayload))
    $planResult = & pwsh -NoProfile -File (Join-Path $windowsRoot 'manage-plan.ps1') -Action SavePlan -PayloadBase64 $planPayload64 -DryRun | ConvertFrom-Json
    Assert-True ($LASTEXITCODE -eq 0) 'Dry-run plan task producer failed.'
    Assert-True (@($planResult.scheduledTasks).Count -eq 1) 'Plan task producer did not create one dry-run definition.'
    Assert-True ([bool]$planResult.scheduledTasks[0].WakeToRun) 'Plan task lost WakeToRun.'
    Assert-True ([bool]$planResult.scheduledTasks[0].StartWhenAvailable) 'Plan task lost StartWhenAvailable.'
    Assert-True ([string]$planResult.scheduledTasks[0].Action -match '\\plan\\plugin\\mashirobot-plugin-plan\\windows\\plan-reminder-worker\.ps1') 'Plan task uses the wrong worker root.'

    $wake = (Invoke-Entry @('-Action','SetWakeup','-StartAt',$future,'-DryRun')) | ConvertFrom-Json
    Assert-True ([bool]$wake.WakeToRun) 'SetWakeup DryRun lost WakeToRun.'
    Assert-True ([bool]$wake.StartWhenAvailable) 'SetWakeup DryRun lost StartWhenAvailable.'
    Assert-True ($wake.IntervalMinutes -eq 10) 'Wakeup repetition changed.'
    Assert-True ([string]$wake.Action -match '\\plan\\plugin\\mashirobot-plugin-plan\\windows\\routine-reminder\.ps1') 'Wakeup task uses the wrong root.'

    $general = (Invoke-Entry @('-Action','SetGeneralReminder','-StartAt',$future,'-Message','测试会议','-DryRun')) | ConvertFrom-Json
    Assert-True ([bool]$general.WakeToRun) 'General reminder lost WakeToRun.'
    Assert-True ([bool]$general.StartWhenAvailable) 'General reminder lost StartWhenAvailable.'
    Assert-True ($general.IntervalMinutes -eq 5) 'General reminder interval is not 5 minutes.'
    Assert-True ([string]$general.Action -match '\\plan\\plugin\\mashirobot-plugin-plan\\windows\\routine-reminder\.ps1') 'General reminder uses the wrong root.'
    Assert-True ($null -eq (Get-ScheduledTask -TaskName $general.TaskName -ErrorAction SilentlyContinue)) 'DryRun created a Windows task.'

    $diskOutput = & pwsh -NoProfile -File (Join-Path $windowsRoot 'check-disk-space.ps1') 2>&1
    Assert-True ($LASTEXITCODE -eq 0) "Disk-space checker failed with temporary DB: $($diskOutput -join [Environment]::NewLine)"
    $diskRead = & $python $planner get-plugin-state --plugin-id mashirobot-plugin-plan --state-key 'disk-space:20gb' | ConvertFrom-Json -AsHashtable
    Assert-True ([bool]$diskRead.found) 'Disk-space state was not written to the temporary SQLite database.'

    $init = & $python $planner init | ConvertFrom-Json
    Assert-True ($init.dbPath -eq $env:OPENCLAW_PLANNER_DB_PATH) 'Test did not use its temporary database.'
    $integrity = & $python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("pragma integrity_check").fetchone()[0])' $env:OPENCLAW_PLANNER_DB_PATH
    Assert-True ($integrity -eq 'ok') 'Temporary database integrity check failed.'
    Write-Output 'PASS: migrated Windows actions, plugin paths, SQLite state, task settings and repetition intervals.'
}
finally {
    Remove-Item Env:OPENCLAW_PLANNER_DB_PATH -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
