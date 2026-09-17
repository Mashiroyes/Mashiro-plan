param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Init', 'SavePlan', 'ModifyItem', 'RecordCompletion', 'QueryDate')]
    [string]$Action,
    [string]$PayloadBase64,
    [string]$Date,
    [string]$OperationId,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
. (Join-Path $PSScriptRoot 'reminder-common.ps1')
if ([string]::IsNullOrWhiteSpace($OperationId)) { $OperationId = [guid]::NewGuid().ToString() }

function Register-PlanReminderTask {
    param([Parameter(Mandatory = $true)][hashtable]$Item)

    $taskName = [string]$Item.taskName
    $start = [DateTimeOffset]::Parse([string]$Item.startAt)
    $workerPath = Join-Path $PSScriptRoot 'plan-reminder-worker.ps1'
    $pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ItemId "{1}" -TaskName "{2}" -OperationId "{3}"' -f `
        $workerPath, [string]$Item.id, $taskName, $OperationId
    $taskAction = New-ScheduledTaskAction -Execute $pwshPath -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -Once -At $start.LocalDateTime
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

    if ($DryRun) {
        return [pscustomobject]@{
            TaskName = $taskName
            StartAt = $start.ToString('o')
            WakeToRun = [bool]$definition.Settings.WakeToRun
            StartWhenAvailable = [bool]$definition.Settings.StartWhenAvailable
            Action = $arguments
        }
    }
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    return [pscustomobject]@{
        TaskName = $taskName
        StartAt = $start.ToString('o')
        WakeToRun = [bool]$definition.Settings.WakeToRun
        StartWhenAvailable = [bool]$definition.Settings.StartWhenAvailable
        Action = $arguments
    }
}

$commandArgs = switch ($Action) {
    'Init' { @('init') }
    'SavePlan' {
        if (-not $PayloadBase64) { throw 'SavePlan requires -PayloadBase64.' }
        @('save-plan', '--payload-base64', $PayloadBase64)
    }
    'ModifyItem' {
        if (-not $PayloadBase64) { throw 'ModifyItem requires -PayloadBase64.' }
        @('modify-item', '--payload-base64', $PayloadBase64)
    }
    'RecordCompletion' {
        if (-not $PayloadBase64) { throw 'RecordCompletion requires -PayloadBase64.' }
        @('record-completion', '--payload-base64', $PayloadBase64)
    }
    'QueryDate' {
        if (-not $Date) { throw 'QueryDate requires -Date.' }
        @('query-date', '--date', $Date)
    }
}

$result = Invoke-PlannerDb -Arguments $commandArgs
$result | Add-Member -NotePropertyName operationId -NotePropertyValue $OperationId -Force
if ($Action -in @('SavePlan', 'ModifyItem')) {
    $taskErrors = @()
    foreach ($oldTask in @($result.canceledTasks)) {
        if (-not $DryRun) {
            try { Remove-OpenClawPlanTask -TaskName ([string]$oldTask) }
            catch { $taskErrors += $_.Exception.Message }
        }
    }
    $scheduled = @()
    $immediate = @()
    $completed = @()
    $skipped = @()
    foreach ($item in @($result.items)) {
        switch ([string]$item.deliveryMode) {
            'schedule' {
                try { $scheduled += Register-PlanReminderTask -Item $item }
                catch { $taskErrors += ('{0}: {1}' -f [string]$item.taskName, $_.Exception.Message) }
            }
            'immediate' {
                $immediate += [string]$item.id
                try {
                    & (Join-Path $PSScriptRoot 'plan-reminder-worker.ps1') `
                        -ItemId ([string]$item.id) `
                        -TaskName ([string]$item.taskName) `
                        -OperationId $OperationId `
                        -DryRun:$DryRun | Out-Null
                } catch { $taskErrors += ('immediate {0}: {1}' -f [string]$item.id, $_.Exception.Message) }
            }
            'skip' { $completed += [string]$item.id }
            default { $skipped += [string]$item.id }
        }
    }
    $result | Add-Member -NotePropertyName scheduledTasks -NotePropertyValue $scheduled -Force
    $result | Add-Member -NotePropertyName immediateItemIds -NotePropertyValue $immediate -Force
    $result | Add-Member -NotePropertyName completedItemIds -NotePropertyValue $completed -Force
    $result | Add-Member -NotePropertyName skippedItemIds -NotePropertyValue $skipped -Force
    $verifiedDatabase = $false
    try {
        $databaseCheck = Invoke-PlannerDb -Arguments @('query-date', '--date', [string]$result.planDate)
        $matchingRevision = @($databaseCheck.revisions | Where-Object { [int]$_.revision_no -eq [int]$result.revisionNo })
        $verifiedDatabase = $matchingRevision.Count -eq 1
    } catch { $result | Add-Member -NotePropertyName databaseError -NotePropertyValue $_.Exception.Message -Force }
    $verifiedTasks = $taskErrors.Count -eq 0
    if (-not $DryRun) {
        foreach ($task in @($scheduled)) {
            if (-not (Get-ScheduledTask -TaskName ([string]$task.TaskName) -ErrorAction SilentlyContinue)) { $verifiedTasks = $false }
        }
        foreach ($oldTask in @($result.canceledTasks)) {
            if (Get-ScheduledTask -TaskName ([string]$oldTask) -ErrorAction SilentlyContinue) { $verifiedTasks = $false }
        }
    }
    $result | Add-Member -NotePropertyName saved -NotePropertyValue $true -Force
    $result | Add-Member -NotePropertyName verifiedDatabase -NotePropertyValue $verifiedDatabase -Force
    $result | Add-Member -NotePropertyName verifiedTasks -NotePropertyValue $verifiedTasks -Force
    $result | Add-Member -NotePropertyName partialFailure -NotePropertyValue (-not ($verifiedDatabase -and $verifiedTasks)) -Force
    if ($taskErrors.Count) { $result | Add-Member -NotePropertyName taskError -NotePropertyValue ($taskErrors -join '; ') -Force }
}

$result | ConvertTo-Json -Depth 12 -Compress
