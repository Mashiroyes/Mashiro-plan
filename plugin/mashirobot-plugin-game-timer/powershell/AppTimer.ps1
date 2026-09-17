param(
    [ValidateSet('Start', 'List', 'Cancel')]
    [string]$Mode = 'Start',

    [string]$ProcessName,
    [string]$DisplayName,
    [ValidateRange(1, 1440)]
    [int]$ReminderMinutes = 15,
    [ValidateRange(2, 1440)]
    [int]$ForceCloseMinutes = 20,

    [string]$LaunchTarget,
    [string[]]$LaunchArguments,
    [ValidateRange(1, 120)]
    [int]$LaunchWaitSeconds = 20,

    [string]$TimerId = 'latest',
    [switch]$NoWeChatReminder
)

$ErrorActionPreference = 'Stop'

$dataRoot = Join-Path $env:LOCALAPPDATA 'CodexAppTimer'
$timerRoot = Join-Path $dataRoot 'timers'
$workerRoot = Join-Path $dataRoot 'workers'
$installedWorker = Join-Path $workerRoot 'AppTimerWorker-v1.ps1'
$sourceWorker = Join-Path $PSScriptRoot 'AppTimerWorker.ps1'

function Get-OpenClawCommand {
    $command = Get-Command openclaw -ErrorAction SilentlyContinue
    if (-not $command) {
        throw 'OpenClaw command was not found. Install and start OpenClaw first.'
    }
    return $command.Source
}

function Invoke-OpenClawJson([string[]]$Arguments) {
    $command = Get-OpenClawCommand
    $output = @(& $command @Arguments 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "OpenClaw command failed: $($output -join ' ')"
    }
    $text = ($output -join "`n").Trim()
    return $text | ConvertFrom-Json
}

function Get-WeChatDelivery {
    $channelStatus = Invoke-OpenClawJson @('channels', 'status', '--json')
    $channelId = 'openclaw-weixin'
    $channel = $channelStatus.channels.$channelId
    if (-not $channel -or -not $channel.configured) {
        throw 'The OpenClaw WeChat channel is not configured.'
    }

    $accountId = [string]$channelStatus.channelDefaultAccountId.$channelId
    if (-not $accountId) {
        $accountId = [string]$channelStatus.channelAccounts.$channelId[0].accountId
    }
    if (-not $accountId) {
        throw 'Could not determine the OpenClaw WeChat account.'
    }

    $sessions = Invoke-OpenClawJson @(
        'sessions', '--active', '1440', '--limit', '100', '--json'
    )
    $prefix = "agent:main:${channelId}:${accountId}:direct:"
    $candidate = @($sessions.sessions |
        Where-Object { $_.runtimePolicySessionKey -like ($prefix + '*') } |
        Sort-Object updatedAt -Descending |
        Select-Object -First 1)
    if ($candidate.Count -eq 0) {
        throw 'No recent direct WeChat session was found. Send OpenClaw a WeChat message first.'
    }

    $target = [string]$candidate[0].runtimePolicySessionKey
    $target = $target.Substring($prefix.Length)
    return [pscustomobject]@{
        Channel = $channelId
        Account = $accountId
        Target = $target
    }
}

function Add-WeChatReminder(
    [string]$Name,
    [datetime]$At,
    [string]$Message
) {
    $delivery = Get-WeChatDelivery
    $atText = $At.ToString('yyyy-MM-ddTHH:mm:sszzz')
    $prefix = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String('5Y+q5Zue5aSN6L+Z5Y+l5o+Q6YaS77yM5LiN6KaB5re75Yqg5YW25LuW5YaF5a6577ya')
    )
    $job = Invoke-OpenClawJson @(
        'cron', 'add',
        '--name', $Name,
        '--at', $atText,
        '--message', ($prefix + $Message),
        '--announce',
        '--channel', $delivery.Channel,
        '--account', $delivery.Account,
        '--to', $delivery.Target,
        '--agent', 'main',
        '--session', 'isolated',
        '--delete-after-run',
        '--json'
    )
    return [pscustomobject]@{
        JobId = [string]$job.id
        Channel = $delivery.Channel
        Account = $delivery.Account
        Target = $delivery.Target
    }
}

function Remove-WeChatReminder([string]$JobId) {
    if (-not $JobId) { return }
    $command = Get-OpenClawCommand
    & $command cron rm $JobId 2>$null | Out-Null
}

function Get-TimerFiles {
    if (-not (Test-Path -LiteralPath $timerRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $timerRoot -File -Filter '*.json' -ErrorAction SilentlyContinue)
}

function Read-TimerFile([IO.FileInfo]$File) {
    return Get-Content -Raw -LiteralPath $File.FullName -Encoding UTF8 | ConvertFrom-Json
}

function Resolve-Timer([string]$RequestedId) {
    $files = Get-TimerFiles
    if ($files.Count -eq 0) { throw 'There are no active application timers.' }
    if ($RequestedId -eq 'latest') {
        $file = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    } else {
        $file = $files | Where-Object BaseName -eq $RequestedId | Select-Object -First 1
    }
    if (-not $file) { throw "Timer not found: $RequestedId" }
    return [pscustomobject]@{ File = $file; State = (Read-TimerFile $file) }
}

function Invoke-List {
    $items = foreach ($file in Get-TimerFiles) {
        $state = Read-TimerFile $file
        $task = Get-ScheduledTask -TaskName $state.TaskName -ErrorAction SilentlyContinue
        [pscustomobject]@{
            TimerId = $state.TimerId
            DisplayName = $state.DisplayName
            ProcessName = $state.ProcessName
            ReminderAt = $state.ReminderAt
            ForceCloseAt = $state.ForceCloseAt
            TaskState = if ($task) { [string]$task.State } else { 'Missing' }
            WeChatReminder = [bool]$state.OpenClawJobId
        }
    }
    @($items) | Format-Table -AutoSize
}

function Invoke-Cancel([string]$RequestedId) {
    $timer = Resolve-Timer $RequestedId
    Unregister-ScheduledTask -TaskName $timer.State.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-WeChatReminder ([string]$timer.State.OpenClawJobId)
    Remove-Item -LiteralPath $timer.File.FullName -Force
    [pscustomobject]@{
        Status = 'Cancelled'
        TimerId = $timer.State.TimerId
        DisplayName = $timer.State.DisplayName
    }
}

function Normalize-ProcessName([string]$Name) {
    if (-not $Name) { return $null }
    if ($Name.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
        return $Name
    }
    return $Name + '.exe'
}

function Wait-ForProcess([string]$Name, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $matches = @(Get-CimInstance Win32_Process |
            Where-Object { $_.Name -eq $Name })
        if ($matches.Count -gt 0) { return $matches }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return @()
}

function Invoke-Start {
    if ($ForceCloseMinutes -le $ReminderMinutes) {
        throw 'ForceCloseMinutes must be greater than ReminderMinutes.'
    }

    $normalizedName = Normalize-ProcessName $ProcessName
    if (-not $normalizedName -and $LaunchTarget -and $LaunchTarget -notmatch '^[a-z]+://') {
        $normalizedName = [IO.Path]::GetFileName($LaunchTarget)
    }
    if (-not $normalizedName) {
        throw 'Start mode requires ProcessName. It can be inferred from a normal executable LaunchTarget.'
    }

    if ($LaunchTarget) {
        if ($LaunchArguments) {
            Start-Process -FilePath $LaunchTarget -ArgumentList $LaunchArguments | Out-Null
        } else {
            Start-Process -FilePath $LaunchTarget | Out-Null
        }
    }

    $processes = Wait-ForProcess $normalizedName $LaunchWaitSeconds
    if ($processes.Count -eq 0) {
        throw "Process $normalizedName was not found. Start it first or increase LaunchWaitSeconds."
    }

    $now = Get-Date
    $reminderAt = $now.AddMinutes($ReminderMinutes)
    $forceCloseAt = $now.AddMinutes($ForceCloseMinutes)
    $friendlyName = if ($DisplayName) {
        $DisplayName
    } else {
        [IO.Path]::GetFileNameWithoutExtension($normalizedName)
    }
    $id = $now.ToString('yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
    $taskName = "Codex-AppTimer-$id"
    $statePath = Join-Path $timerRoot ($id + '.json')
    $executablePath = @($processes |
        Where-Object ExecutablePath |
        Select-Object -First 1 -ExpandProperty ExecutablePath)
    $executablePath = if ($executablePath.Count) { [string]$executablePath[0] } else { $null }

    New-Item -ItemType Directory -Path $timerRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $workerRoot -Force | Out-Null
    Copy-Item -LiteralPath $sourceWorker -Destination $installedWorker -Force

    $openClawJob = $null
    if (-not $NoWeChatReminder) {
        $messageTemplate = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String('ezB9IOWIhumSn+WIsOS6hu+8jOivt+eOsOWcqOS/neWtmOW5tuWFs+mXreOAinsxfeOAi+OAguWGjei/hyB7Mn0g5YiG6ZKf5LuN5pyq5YWz6Zet77yM55S16ISR5Lya6Ieq5Yqo5by65Yi26YCA5Ye644CC')
        )
        $message = $messageTemplate -f $ReminderMinutes, $friendlyName, ($ForceCloseMinutes - $ReminderMinutes)
        $openClawJob = Add-WeChatReminder "app-timer-$id" $reminderAt $message
    }

    $state = [pscustomobject]@{
        TimerId = $id
        DisplayName = $friendlyName
        ProcessName = $normalizedName
        ExecutablePath = $executablePath
        StartedAt = $now.ToString('o')
        ReminderAt = $reminderAt.ToString('o')
        ForceCloseAt = $forceCloseAt.ToString('o')
        ReminderMinutes = $ReminderMinutes
        ForceCloseMinutes = $ForceCloseMinutes
        TaskName = $taskName
        OpenClawJobId = if ($openClawJob) { $openClawJob.JobId } else { $null }
    }
    $state | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $statePath -Encoding UTF8

    try {
        $actionArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installedWorker`" -StatePath `"$statePath`""
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArgs
        $trigger = New-ScheduledTaskTrigger -Once -At $forceCloseAt
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal `
            -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
            -LogonType Interactive `
            -RunLevel Limited
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal `
            -Force | Out-Null
    } catch {
        if ($openClawJob) { Remove-WeChatReminder $openClawJob.JobId }
        Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
        throw
    }

    [pscustomobject]@{
        Status = 'Started'
        TimerId = $id
        DisplayName = $friendlyName
        ProcessName = $normalizedName
        ReminderAt = $reminderAt.ToString('yyyy-MM-dd HH:mm:ss')
        ForceCloseAt = $forceCloseAt.ToString('yyyy-MM-dd HH:mm:ss')
        WeChatReminder = (-not $NoWeChatReminder)
    }
}

switch ($Mode) {
    'Start' { Invoke-Start }
    'List' { Invoke-List }
    'Cancel' { Invoke-Cancel $TimerId }
}
