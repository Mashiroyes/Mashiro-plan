Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'reminder-common.ps1')

$script:WakeupTaskPrefix = 'OpenClaw-Wakeup-'
$script:OpenClawCmd = 'D:\Program\nodejs\npm_global24\openclaw.cmd'

function Get-ShanghaiNow {
    return [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(
        [DateTimeOffset]::UtcNow,
        'China Standard Time'
    )
}

function Read-WakeupState {
    return Get-PlanPluginState -StateKey 'wakeup:active'
}

function Write-WakeupState {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$State)

    Set-PlanPluginState -StateKey 'wakeup:active' -State $State
}

function Remove-WakeupScheduledTask {
    param([string]$TaskName)

    if (-not $TaskName -or -not $TaskName.StartsWith($script:WakeupTaskPrefix)) {
        return
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

function Remove-AllWakeupScheduledTasks {
    param([string]$ExceptTaskName)

    $removed = @()
    $tasks = @(Get-ScheduledTask -TaskName ($script:WakeupTaskPrefix + '*') -ErrorAction SilentlyContinue)
    foreach ($task in $tasks) {
        if ($ExceptTaskName -and $task.TaskName -eq $ExceptTaskName) { continue }
        Remove-WakeupScheduledTask -TaskName $task.TaskName
        $removed += $task.TaskName
    }
    return $removed
}

function Remove-LegacyWakeupCronJobs {
    if (-not (Test-Path -LiteralPath $script:OpenClawCmd)) {
        Write-WakeupLog "Legacy cron cleanup skipped; OpenClaw command missing: $script:OpenClawCmd"
        return @()
    }

    try {
        $raw = & $script:OpenClawCmd cron list --all --json 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($raw -join [Environment]::NewLine) }
        $data = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
        $removed = @()
        foreach ($job in @($data.jobs)) {
            if ([string]$job.payload.kind -ne 'agentTurn') { continue }
            $text = @(
                [string]$job.name,
                [string]$job.displayName,
                [string]$job.description,
                [string]$job.payload.message
            ) -join ' '
            if ($text -notmatch '(?i)起床|wake[\s_-]*up|wakeup') { continue }

            $removeOutput = & $script:OpenClawCmd cron rm ([string]$job.id) --json 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw ('Could not remove legacy wakeup cron {0}: {1}' -f $job.id, ($removeOutput -join [Environment]::NewLine))
            }
            $removed += [string]$job.id
            Write-WakeupLog "Removed legacy wakeup agentTurn cron id=$($job.id) name=$($job.name)"
        }
        return $removed
    } catch {
        Write-WakeupLog "ERROR cleaning legacy wakeup crons: $($_.Exception.Message)"
        throw
    }
}

function Write-WakeupLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $logDir = Join-Path $env:USERPROFILE '.openclaw\logs'
    [IO.Directory]::CreateDirectory($logDir) | Out-Null
    $logPath = Join-Path $logDir 'mashirobot.log'
    $line = '{0} [{1}] {2}' -f (Get-ShanghaiNow).ToString('yyyy-MM-dd HH:mm:ss zzz'), $script:PluginId, $Message
    [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
