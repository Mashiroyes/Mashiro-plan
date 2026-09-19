param(
    [Parameter(Mandatory = $true)][ValidateSet('Reminder', 'Force')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$TaskId,
    [Parameter(Mandatory = $true)][string]$SqlitePath,
    [Parameter(Mandatory = $true)][string]$ScheduledTaskName,
    [switch]$DryRun,
    [switch]$FixtureQueueVault
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$MachineModule = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\MashiroBot.MachineConfig.ps1'
$DbHelper = Join-Path $PSScriptRoot 'game-timer-db-v1.mjs'

function Write-WorkerLog([string]$Message) {
    $logDir = Join-Path $env:USERPROFILE '.openclaw\logs'
    [IO.Directory]::CreateDirectory($logDir) | Out-Null
    $logPath = Join-Path $logDir 'mashirobot.log'
    $line = '{0} [mashirobot-plugin-game-timer] {1}' -f ([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz')), $Message
    [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Get-TimerState {
    $encoded = & node $DbHelper get64 $SqlitePath $TaskId 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($encoded -join [Environment]::NewLine) }
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($encoded -join '').Trim()))
    return ($json | ConvertFrom-Json)
}

function Update-TimerState([hashtable]$Payload) {
    $Payload.updated_at = [DateTimeOffset]::UtcNow.ToString('o')
    $json = $Payload | ConvertTo-Json -Compress -Depth 6
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $output = & node $DbHelper update $SqlitePath $TaskId $encoded 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
}

function Send-Weixin([string]$Message) {
    if ($DryRun) { return }
    if (-not (Test-Path -LiteralPath $MachineModule -PathType Leaf)) { throw "MashiroBot machine configuration helper is missing: $MachineModule" }
    Import-Module $MachineModule -Force
    $delivery = Resolve-MashiroWeixinDelivery
    $lastError = $null
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            $output = & $delivery.OpenClawCommand message send --json `
                --channel 'openclaw-weixin' --account $delivery.Account `
                --target $delivery.Target --message $Message 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
            return
        } catch {
            $lastError = $_.Exception
            Write-WorkerLog ('Weixin send attempt {0}/4 failed: {1}' -f $attempt, $lastError.Message)
            if ($attempt -lt 4) { Start-Sleep -Seconds 5 }
        }
    }
    throw $lastError
}

function Get-ExactProcesses($State) {
    $allNamed = @(Get-CimInstance Win32_Process -Filter ("Name='{0}'" -f $State.process_name.Replace("'", "''")))
    $matches = @($allNamed | Where-Object {
        $_.ExecutablePath -and [string]::Equals(
            [IO.Path]::GetFullPath([string]$_.ExecutablePath),
            [IO.Path]::GetFullPath([string]$State.executable_path),
            [StringComparison]::OrdinalIgnoreCase
        )
    })
    return [pscustomobject]@{ AllNamed = $allNamed; Matches = $matches }
}

function Request-NormalClose([array]$Processes) {
    foreach ($process in $Processes) {
        try {
            $runtimeProcess = [Diagnostics.Process]::GetProcessById([int]$process.ProcessId)
            if ($runtimeProcess.MainWindowHandle -ne 0) {
                $runtimeProcess.CloseMainWindow() | Out-Null
            }
        } catch {
            Write-WorkerLog ('Normal close request skipped for PID {0}: {1}' -f $process.ProcessId, $_.Exception.Message)
        }
    }
}

function Wait-ForExactProcesses($State, [int]$Seconds = 3) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
    do {
        $remaining = @((Get-ExactProcesses $State).Matches)
        if ($remaining.Count -eq 0) { return @() }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return @((Get-ExactProcesses $State).Matches)
}

try {
    $state = Get-TimerState
    if (-not $state) { exit 0 }

    if ($Mode -eq 'Reminder') {
        $message = '真白，{0}的游玩时间到了，请保存并关闭游戏。{1}分钟后仍未关闭，电脑会强制退出游戏。' -f $state.display_name, $state.force_after
        try {
            Send-Weixin $message
            Update-TimerState @{ status = 'reminded'; reminded_at = [DateTimeOffset]::UtcNow.ToString('o'); error = $null }
        } catch {
            Update-TimerState @{ status = 'reminder_failed'; error = $_.Exception.Message }
        }
    } else {
        $initial = Get-ExactProcesses $state
        $matches = @($initial.Matches)
        $closed = @($matches | ForEach-Object { [int]$_.ProcessId })
        if ($matches.Count -gt 0) {
            Request-NormalClose $matches
        }
        $remaining = if ($matches.Count -gt 0) { @(Wait-ForExactProcesses $state 3) } else { @() }
        $forced = @()
        foreach ($process in $remaining) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            $forced += [int]$process.ProcessId
        }
        foreach ($processId in $forced) {
            Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        }
        if ($closed.Count -gt 0) {
            Update-TimerState @{ status = 'closed'; closed_pids_json = ($closed | ConvertTo-Json -Compress); error = $null }
            $message = if ($forced.Count -gt 0) {
                '真白，{0}未能正常关闭，已按约定强制退出。' -f $state.display_name
            } else {
                '真白，{0}已正常关闭。' -f $state.display_name
            }
            try { Send-Weixin $message } catch {}
        } elseif (@($initial.AllNamed).Count -gt 0) {
            Update-TimerState @{ status = 'path_mismatch'; closed_pids_json = '[]'; error = 'process name matched but executable path did not' }
        } else {
            Update-TimerState @{ status = 'already_closed'; closed_pids_json = '[]'; error = $null }
        }
        if ($forced.Count -gt 0 -and ((-not $DryRun) -or $FixtureQueueVault)) {
            $queued = & node $DbHelper queue-vault $SqlitePath $TaskId 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($queued -join [Environment]::NewLine) }
            if (-not $FixtureQueueVault) { Start-ScheduledTask -TaskName 'MashiroBot-GameLocker-Reconcile' -ErrorAction Stop }
        }
    }
} catch {
    Write-WorkerLog ('Worker failed for task {0}: {1}' -f $TaskId, $_.Exception.Message)
    try { Update-TimerState @{ status = 'worker_failed'; error = $_.Exception.Message } } catch {}
    exit 1
} finally {
    if (-not $DryRun) {
        Unregister-ScheduledTask -TaskName $ScheduledTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}
