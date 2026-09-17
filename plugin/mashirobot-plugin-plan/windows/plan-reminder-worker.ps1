param(
    [Parameter(Mandatory = $true)][string]$ItemId,
    [string]$TaskName,
    [string]$OperationId,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
. (Join-Path $PSScriptRoot 'reminder-common.ps1')

try {
    $claim = Invoke-PlannerDb -Arguments @('prepare-item', '--item-id', $ItemId)
    if (-not [bool]$claim.shouldSend) {
        Write-ReminderLog "Plan item $ItemId skipped: $($claim.reason)"
        exit 0
    }

    $item = $claim.item
    $timeText = [string]$item.start_time
    if ($item.end_time) { $timeText += '—' + [string]$item.end_time }
    $message = '真白，计划时间到了：{0} {1}。' -f $timeText, [string]$item.title
    Send-OpenClawWeixinMessage -Message $message -DryRun:$DryRun | Out-Null
    Invoke-PlannerDb -Arguments @('finish-item', '--item-id', $ItemId, '--status', 'sent') | Out-Null
    Write-ReminderLog "Plan reminder sent item=$ItemId operation=$OperationId title=$($item.title) dryRun=$DryRun"
} catch {
    $errorText = $_.Exception.Message
    try {
        Invoke-PlannerDb -Arguments @(
            'finish-item', '--item-id', $ItemId, '--status', 'failed', '--error', $errorText
        ) | Out-Null
    } catch {
        Write-ReminderLog "Could not persist plan reminder failure item=${ItemId}: $($_.Exception.Message)"
    }
    Write-ReminderLog "ERROR plan reminder item=${ItemId}: $errorText"
    throw
} finally {
    if (-not $DryRun -and $TaskName) { Remove-OpenClawPlanTask -TaskName $TaskName }
}
