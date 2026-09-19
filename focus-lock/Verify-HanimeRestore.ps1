$ErrorActionPreference = 'Stop'
$taskName = 'CodexFocusLock-HanimeRestore'
$resultPath = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\temporary-unblock-hanime1-task-verification.json'
try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    $repair = Get-ScheduledTask -TaskName 'CodexFocusLock-Repair' -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Status='Verified'; TaskName=$task.TaskName; State=[string]$task.State
        UserId=$task.Principal.UserId; RunLevel=[string]$task.Principal.RunLevel
        Execute=$task.Actions.Execute; Arguments=$task.Actions.Arguments
        StartBoundary=$task.Triggers.StartBoundary
        StartWhenAvailable=$task.Settings.StartWhenAvailable
        NextRunTime=$info.NextRunTime.ToString('o')
        RepairTaskState=if ($repair) { [string]$repair.State } else { 'NotFound' }
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    [pscustomobject]@{Status='Failed';Error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw
}
