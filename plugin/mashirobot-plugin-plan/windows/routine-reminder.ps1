param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'Shower','StartNight','CheckNight',
        'SetWakeup','GetWakeup','CancelWakeup','RunWakeup',
        'CleanupLegacyWakeup','SetGeneralReminder','RunGeneralReminder'
    )]
    [string]$Action,
    [string]$StartAt,
    [string]$Message,
    [string]$ReminderId,
    [string]$TaskName,
    [string]$OperationId,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
if ([string]::IsNullOrWhiteSpace($OperationId)) { $OperationId = [guid]::NewGuid().ToString() }

function Remove-GeneralReminderScheduledTask {
    param([string]$Name)

    if (-not $Name -or -not $Name.StartsWith('OpenClaw-General-')) { return }
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
}

function Invoke-SetGeneralReminder {
    if (-not $StartAt) { throw 'SetGeneralReminder 需要 -StartAt。' }
    if ([string]::IsNullOrWhiteSpace($Message)) { throw 'SetGeneralReminder 需要非空 -Message。' }
    . (Join-Path $PSScriptRoot 'reminder-common.ps1')

    $culture = [Globalization.CultureInfo]::InvariantCulture
    $styles = [Globalization.DateTimeStyles]::RoundtripKind
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($StartAt, $culture, $styles, [ref]$parsed)) {
        throw 'StartAt 必须是带时区的 ISO 日期时间，例如 2026-08-03T12:00:00+08:00。'
    }
    $shanghaiZone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    $start = [TimeZoneInfo]::ConvertTime($parsed, $shanghaiZone)
    $now = Get-ShanghaiNow
    if ($start -le $now) { throw ('提醒时间已经过去：{0}' -f $start.ToString('yyyy-MM-dd HH:mm:ss zzz')) }

    $payloadJson = @{ content = $Message.Trim(); scheduledAt = $start.ToString('o') } | ConvertTo-Json -Compress
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payloadJson)
    $payloadBase64 = [Convert]::ToBase64String($payloadBytes)
    $reminder = Invoke-PlannerDb -Arguments @('create-general-reminder', '--payload-base64', $payloadBase64)
    $newReminderId = [string]$reminder.id
    $newTaskName = [string]$reminder.taskName

    $pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action RunGeneralReminder -ReminderId "{1}" -TaskName "{2}" -OperationId "{3}"' -f $PSCommandPath, $newReminderId, $newTaskName, $OperationId
    $taskAction = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Once -At $start.LocalDateTime -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet `
        -WakeToRun `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
        -Disable
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Limited
    $definition = New-ScheduledTask -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal

    $taskError = ''
    if (-not $DryRun) {
        try {
            Register-ScheduledTask -TaskName $newTaskName -InputObject $definition -Force | Out-Null
            Enable-ScheduledTask -TaskName $newTaskName | Out-Null
        } catch {
            $errorText = $_.Exception.Message
            try {
                Invoke-PlannerDb -Arguments @(
                    'finish-general-reminder', '--reminder-id', $newReminderId,
                    '--status', 'failed', '--error', $errorText
                ) | Out-Null
            } catch {
                Write-ReminderLog "Could not persist general reminder registration failure id=${newReminderId}: $($_.Exception.Message)"
            }
            Remove-GeneralReminderScheduledTask -Name $newTaskName
            $taskError = $errorText
        }
    }

    $databaseCheck = Invoke-PlannerDb -Arguments @('query-general-reminder', '--reminder-id', $newReminderId)
    $verifiedDatabase = [bool]$databaseCheck.found
    $verifiedTasks = [bool]$DryRun -or [bool](Get-ScheduledTask -TaskName $newTaskName -ErrorAction SilentlyContinue)
    [pscustomobject]@{
        operationId = $OperationId
        ReminderId = $newReminderId
        TaskName = $newTaskName
        StartAt = [string]$reminder.scheduledAt
        IntervalMinutes = 5
        WakeToRun = [bool]$definition.Settings.WakeToRun
        StartWhenAvailable = [bool]$definition.Settings.StartWhenAvailable
        DryRun = [bool]$DryRun
        Action = $arguments
        verifiedDatabase = $verifiedDatabase
        verifiedTasks = $verifiedTasks
        partialFailure = -not ($verifiedDatabase -and $verifiedTasks)
        taskError = $taskError
        message = if ($verifiedDatabase -and $verifiedTasks) { '通用提醒已设置。' } else { '通用提醒未完全确认。' }
    } | ConvertTo-Json -Compress
}

function Invoke-RunGeneralReminder {
    if (-not $ReminderId) { throw 'RunGeneralReminder 需要 -ReminderId。' }
    if (-not $TaskName) { throw 'RunGeneralReminder 需要 -TaskName。' }
    . (Join-Path $PSScriptRoot 'reminder-common.ps1')

    $claim = Invoke-PlannerDb -Arguments @('prepare-general-reminder', '--reminder-id', $ReminderId)
    if (-not [bool]$claim.shouldSend) {
        $reason = [string]$claim.reason
        Write-ReminderLog "General reminder skipped id=$ReminderId reason=$reason"
        if (($reason -eq 'acknowledged' -or $reason -eq 'missing') -and -not $DryRun) {
            Remove-GeneralReminderScheduledTask -Name $TaskName
        }
        return
    }

    $content = [string]$claim.reminder.content
    $reminderText = '提醒：{0}。完成后回复“收到”。' -f $content
    try {
        Send-OpenClawWeixinMessage -Message $reminderText -DryRun:$DryRun | Out-Null
        Invoke-PlannerDb -Arguments @(
            'finish-general-reminder', '--reminder-id', $ReminderId, '--status', 'sent'
        ) | Out-Null
        Write-ReminderLog "General reminder sent id=$ReminderId dryRun=$DryRun"
    } catch {
        $errorText = $_.Exception.Message
        try {
            Invoke-PlannerDb -Arguments @(
                'finish-general-reminder', '--reminder-id', $ReminderId,
                '--status', 'failed', '--error', $errorText
            ) | Out-Null
        } catch {
            Write-ReminderLog "Could not persist general reminder failure id=${ReminderId}: $($_.Exception.Message)"
        }
        Write-ReminderLog "ERROR general reminder id=${ReminderId}: $errorText"
        throw
    }
}

function Invoke-StartNight {
    . (Join-Path $PSScriptRoot 'routine-common.ps1')
    $now = Get-ShanghaiNow
    $state = New-RoutineState -Now $now
    Write-RoutineState -State $state
    Write-Output '真白，先确认单词有没有打卡。打完后回复“已打卡”，睡下后回复“已睡觉”。'
}

function Invoke-CheckNight {
    . (Join-Path $PSScriptRoot 'routine-common.ps1')
    $now = Get-ShanghaiNow
    $insideWindow = ($now.Hour -ge 22) -or ($now.Hour -le 2)
    if (-not $insideWindow -or ($now.Hour -eq 22 -and $now.Minute -eq 0)) {
        Write-Output 'NO_REPLY'
        return
    }

    $routineDate = Get-NightRoutineDate -Now $now
    $state = Read-RoutineState
    if ($null -eq $state -or [string]$state.routineDate -ne $routineDate) {
        $state = New-RoutineState -Now $now
        Write-RoutineState -State $state
    }
    if ([bool]$state.slept) {
        Write-Output 'NO_REPLY'
    } elseif ([bool]$state.wordChecked) {
        Write-Output '真白，单词已经打卡了，该睡觉啦。睡下后回复“已睡觉”。'
    } else {
        Write-Output '真白，先把单词打卡完成，打完回复“已打卡”。然后再睡觉。'
    }
}

function Invoke-SetWakeup {
    if (-not $StartAt) { throw 'SetWakeup 需要 -StartAt。' }
    . (Join-Path $PSScriptRoot 'wakeup-common.ps1')

    $culture = [Globalization.CultureInfo]::InvariantCulture
    $styles = [Globalization.DateTimeStyles]::RoundtripKind
    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($StartAt, $culture, $styles, [ref]$parsed)) {
        throw 'StartAt 必须是带时区的 ISO 日期时间，例如 2026-08-02T08:30:00+08:00。'
    }
    $shanghaiZone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    $start = [TimeZoneInfo]::ConvertTime($parsed, $shanghaiZone)
    $now = Get-ShanghaiNow
    if ($start -le $now) { throw ('起床时间已经过去：{0}' -f $start.ToString('yyyy-MM-dd HH:mm:ss zzz')) }

    $newTaskName = $script:WakeupTaskPrefix + $start.ToString('yyyyMMdd-HHmmss')
    $pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action RunWakeup -TaskName "{1}" -OperationId "{2}"' -f $PSCommandPath, $newTaskName, $OperationId
    $taskAction = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Once -At $start.LocalDateTime -RepetitionInterval (New-TimeSpan -Minutes 10)
    $settings = New-ScheduledTaskSettingsSet `
        -WakeToRun `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
        -Disable
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Limited
    $definition = New-ScheduledTask -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal

    if ($DryRun) {
        [pscustomobject]@{
            operationId = $OperationId
            DryRun = $true
            TaskName = $newTaskName
            StartAt = $start.ToString('o')
            IntervalMinutes = 10
            WakeToRun = [bool]$definition.Settings.WakeToRun
            StartWhenAvailable = [bool]$definition.Settings.StartWhenAvailable
            Action = $arguments
            message = ('已验证 {0} 的起床提醒定义。' -f $start.ToString('yyyy-MM-dd HH:mm'))
            verifiedDatabase = $true
            verifiedTasks = $true
            partialFailure = $false
        } | ConvertTo-Json -Compress
        return
    }

    $oldState = Read-WakeupState
    $oldTaskName = if ($oldState -and $oldState.ContainsKey('windowsTaskName')) { [string]$oldState.windowsTaskName } else { '' }
    Register-ScheduledTask -TaskName $newTaskName -InputObject $definition -Force | Out-Null
    try {
        $state = @{
            active = $true; startAt = $start.ToString('o'); intervalMinutes = 10; stopReply = '已起床'
            windowsTaskName = $newTaskName; triggeredAt = $null; completedAt = $null
            operationId = $OperationId
            lastReminderAt = $null; lastError = $null; updatedAt = $now.ToString('o')
        }
        Write-WakeupState -State $state
        Enable-ScheduledTask -TaskName $newTaskName | Out-Null
    } catch {
        Remove-WakeupScheduledTask -TaskName $newTaskName
        if ($oldState) { Write-WakeupState -State $oldState }
        throw
    }
    if ($oldTaskName -and $oldTaskName -ne $newTaskName) { Remove-WakeupScheduledTask -TaskName $oldTaskName }
    Remove-AllWakeupScheduledTasks -ExceptTaskName $newTaskName | Out-Null
    $verifiedState = Read-WakeupState
    $verifiedDatabase = $verifiedState -and [bool]$verifiedState.active -and [string]$verifiedState.windowsTaskName -eq $newTaskName -and [string]$verifiedState.operationId -eq $OperationId
    $verifiedTasks = [bool](Get-ScheduledTask -TaskName $newTaskName -ErrorAction SilentlyContinue)
    [pscustomobject]@{
        operationId=$OperationId; message=('已设置 {0} 的起床提醒。到点后会唤醒电脑、播放网易云，并每 10 分钟提醒，直到回复“已起床”。' -f $start.ToString('yyyy-MM-dd HH:mm'))
        verifiedDatabase=[bool]$verifiedDatabase; verifiedTasks=$verifiedTasks
        partialFailure=-not ($verifiedDatabase -and $verifiedTasks); taskName=$newTaskName; startAt=$start.ToString('o')
    } | ConvertTo-Json -Compress
}

function Invoke-GetWakeup {
    . (Join-Path $PSScriptRoot 'wakeup-common.ps1')
    $state = Read-WakeupState
    if (-not $state -or -not [bool]$state.active) {
        [pscustomobject]@{ operationId=$OperationId; message='当前没有活动的起床提醒。'; verifiedDatabase=$true; verifiedTasks=$true } | ConvertTo-Json -Compress
        return
    }
    $currentTaskName = if ($state.ContainsKey('windowsTaskName')) { [string]$state.windowsTaskName } else { '' }
    $task = if ($currentTaskName) { Get-ScheduledTask -TaskName $currentTaskName -ErrorAction SilentlyContinue } else { $null }
    if (-not $task -or -not $currentTaskName.StartsWith($script:WakeupTaskPrefix)) {
        $state.active = $false
        $state.lastError = 'Active state had no matching Windows wakeup task.'
        $state.updatedAt = (Get-ShanghaiNow).ToString('o')
        Write-WakeupState -State $state
        Write-WakeupLog 'Invalid active wakeup state was marked inactive during query.'
        [pscustomobject]@{ operationId=$OperationId; message='当前没有有效的起床提醒；发现的失效状态已清理。'; verifiedDatabase=$true; verifiedTasks=$true } | ConvertTo-Json -Compress
        return
    }
    $start = [DateTimeOffset]::Parse([string]$state.startAt)
    [pscustomobject]@{ operationId=$OperationId; message=('当前起床提醒：{0}。到点后会唤醒电脑、播放网易云，并每 10 分钟提醒，直到回复“已起床”。' -f $start.ToString('yyyy-MM-dd HH:mm')); verifiedDatabase=$true; verifiedTasks=$true } | ConvertTo-Json -Compress
}

function Invoke-CancelWakeup {
    . (Join-Path $PSScriptRoot 'wakeup-common.ps1')
    $state = Read-WakeupState
    $removedWindowsTasks = @(Remove-AllWakeupScheduledTasks)
    $now = Get-ShanghaiNow
    $newState = @{
        active = $false
        startAt = if ($state -and $state.ContainsKey('startAt')) { $state.startAt } else { $null }
        intervalMinutes = 10; stopReply = '已起床'; windowsTaskName = $null
        triggeredAt = if ($state -and $state.ContainsKey('triggeredAt')) { $state.triggeredAt } else { $null }
        completedAt = if ($state -and $state.ContainsKey('completedAt')) { $state.completedAt } else { $null }
        canceledAt = $now.ToString('o')
        lastReminderAt = if ($state -and $state.ContainsKey('lastReminderAt')) { $state.lastReminderAt } else { $null }
        lastError = $null; updatedAt = $now.ToString('o')
    }
    Write-WakeupState -State $newState
    Write-WakeupLog ('Wakeup alarm canceled; windowsTasks={0}' -f $removedWindowsTasks.Count)
    $verifiedState = Read-WakeupState
    $remainingTasks = @(Get-ScheduledTask -TaskName ($script:WakeupTaskPrefix + '*') -ErrorAction SilentlyContinue)
    $verifiedDatabase = $verifiedState -and -not [bool]$verifiedState.active
    $verifiedTasks = $remainingTasks.Count -eq 0
    $message = if ($removedWindowsTasks.Count -or ($state -and [bool]$state.active)) { '已取消起床提醒。' } else { '当前没有活动的起床提醒。' }
    [pscustomobject]@{ operationId=$OperationId; message=$message; verifiedDatabase=[bool]$verifiedDatabase; verifiedTasks=$verifiedTasks; partialFailure=-not ($verifiedDatabase -and $verifiedTasks) } | ConvertTo-Json -Compress
}

function Invoke-CleanupLegacyWakeup {
    . (Join-Path $PSScriptRoot 'wakeup-common.ps1')
    $removedCrons = @(Remove-LegacyWakeupCronJobs)
    Write-WakeupLog ('Legacy wakeup cron maintenance completed; removed={0}' -f $removedCrons.Count)
    [pscustomobject]@{ RemovedLegacyCrons = $removedCrons } | ConvertTo-Json -Compress
}

function Initialize-MasterVolumeType {
    if ('OpenClawAudio.MasterVolume' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace OpenClawAudio {
    enum EDataFlow { eRender, eCapture, eAll }
    enum ERole { eConsole, eMultimedia, eCommunications }
    [Flags] enum CLSCTX : uint { ALL = 23 }
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    interface IMMDeviceEnumerator { int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices); int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint); }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    interface IMMDevice { int Activate(ref Guid iid, CLSCTX clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer); }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    interface IAudioEndpointVolume { int RegisterControlChangeNotify(IntPtr notify); int UnregisterControlChangeNotify(IntPtr notify); int GetChannelCount(out uint channelCount); int SetMasterVolumeLevel(float levelDb, Guid eventContext); int SetMasterVolumeLevelScalar(float level, Guid eventContext); }
    public static class MasterVolume {
        public static void SetMaximum() {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device; Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device));
            Guid iid = typeof(IAudioEndpointVolume).GUID; object endpointObject;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX.ALL, IntPtr.Zero, out endpointObject));
            var endpoint = (IAudioEndpointVolume)endpointObject;
            Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(1.0f, Guid.Empty));
        }
    }
}
'@
}

function Invoke-RunWakeup {
    if (-not $TaskName) { throw 'RunWakeup 需要 -TaskName。' }
    . (Join-Path $PSScriptRoot 'wakeup-common.ps1')
    . (Join-Path $PSScriptRoot 'cloudmusic-playback.ps1')

    $cloudMusicPath = 'D:\Program\CloudMusic\cloudmusic.exe'
    $openClawCmd = 'D:\Program\nodejs\npm_global24\openclaw.cmd'
    $weixinAccount = 'ea8fd13b2100-im-bot'
    $weixinTarget = 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat'
    $reminderText = '真白，该起床啦。起来后回复“已起床”。'
    $state = Read-WakeupState
    if ($null -eq $state -or -not [bool]$state.active -or [string]$state.windowsTaskName -ne $TaskName) {
        Write-WakeupLog "Task $TaskName is stale or inactive; removing it."
        if (-not $DryRun) { Remove-WakeupScheduledTask -TaskName $TaskName }
        return
    }
    $now = Get-ShanghaiNow
    if (-not $state.triggeredAt) {
        $state.triggeredAt = $now.ToString('o'); $state.updatedAt = $now.ToString('o'); Write-WakeupState -State $state
        if ($DryRun) {
            Initialize-MasterVolumeType
            if (-not (Test-Path -LiteralPath $cloudMusicPath)) { throw "CloudMusic executable not found: $cloudMusicPath" }
            if (-not (Test-Path -LiteralPath $openClawCmd)) { throw "OpenClaw command not found: $openClawCmd" }
            Write-WakeupLog 'DRY RUN: volume API compiled; CloudMusic and OpenClaw paths verified.'
        } else {
            try { Initialize-MasterVolumeType; [OpenClawAudio.MasterVolume]::SetMaximum(); Write-WakeupLog 'Master volume set to 100%.' }
            catch { Write-WakeupLog ('ERROR setting volume: {0}' -f $_.Exception.Message) }
        }
    }
    if (-not $DryRun) {
        Write-WakeupLog 'Checking CloudMusic playback on this wakeup run.'
        try {
            if (Test-CloudMusicPlaybackActive -DurationMilliseconds 1200) {
                Write-WakeupLog 'CloudMusic is already producing audio; playback action skipped.'
            } else {
                Write-WakeupLog 'CloudMusic is silent; retrying playback.'
                $playbackResult = Start-CloudMusicPlayback -ExecutablePath $cloudMusicPath
                Write-WakeupLog ('CloudMusic playback verified: method={0}, attempts={1}, pid={2}, hwnd={3}.' -f $playbackResult.Method, $(if ($playbackResult.ContainsKey('Attempts')) { $playbackResult.Attempts } else { 0 }), $playbackResult.ProcessId, $playbackResult.WindowHandle)
            }
        } catch { Write-WakeupLog ('ERROR starting CloudMusic: {0}' -f $_.Exception.Message) }
    }
    try {
        if ($DryRun) { Write-WakeupLog 'DRY RUN: would send Weixin wakeup reminder.' }
        else {
            $sendOutput = & $openClawCmd message send --json --channel 'openclaw-weixin' --account $weixinAccount --target $weixinTarget --message $reminderText 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($sendOutput -join [Environment]::NewLine) }
            Write-WakeupLog 'Weixin wakeup reminder sent.'
        }
        $latest = Read-WakeupState
        if ($latest -and [bool]$latest.active -and [string]$latest.windowsTaskName -eq $TaskName) {
            $latest.lastReminderAt = $now.ToString('o'); $latest.lastError = $null; $latest.updatedAt = $now.ToString('o'); Write-WakeupState -State $latest
        }
    } catch {
        Write-WakeupLog ('ERROR sending Weixin reminder: {0}' -f $_.Exception.Message)
        $latest = Read-WakeupState
        if ($latest -and [bool]$latest.active -and [string]$latest.windowsTaskName -eq $TaskName) {
            $latest.lastError = $_.Exception.Message; $latest.updatedAt = $now.ToString('o'); Write-WakeupState -State $latest
        }
    }
}

switch ($Action) {
    'Shower' { Write-Output '真白，该洗澡啦。洗完就准备打卡和睡觉。' }
    'StartNight' { Invoke-StartNight }
    'CheckNight' { Invoke-CheckNight }
    'SetWakeup' { Invoke-SetWakeup }
    'GetWakeup' { Invoke-GetWakeup }
    'CancelWakeup' { Invoke-CancelWakeup }
    'RunWakeup' { Invoke-RunWakeup }
    'CleanupLegacyWakeup' { Invoke-CleanupLegacyWakeup }
    'SetGeneralReminder' { Invoke-SetGeneralReminder }
    'RunGeneralReminder' { Invoke-RunGeneralReminder }
}
