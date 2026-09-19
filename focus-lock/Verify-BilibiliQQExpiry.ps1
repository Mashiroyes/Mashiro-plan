$ErrorActionPreference = 'Stop'
$taskName = 'CodexFocusLock-BilibiliQQExpire'
$resultPath = 'C:\ProgramData\CodexFocusLock\bilibili-qq-expiry-verification.json'

try {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
    [pscustomobject]@{
        Status = 'Verified'
        VerifiedAt = (Get-Date).ToString('o')
        TaskName = $task.TaskName
        State = [string]$task.State
        UserId = $task.Principal.UserId
        RunLevel = [string]$task.Principal.RunLevel
        Execute = $task.Actions.Execute
        Arguments = $task.Actions.Arguments
        StartBoundary = $task.Triggers.StartBoundary
        StartWhenAvailable = $task.Settings.StartWhenAvailable
        RestartCount = $task.Settings.RestartCount
        RestartInterval = [string]$task.Settings.RestartInterval
        NextRunTime = $info.NextRunTime.ToString('o')
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
catch {
    [pscustomobject]@{
        Status = 'Failed'
        VerifiedAt = (Get-Date).ToString('o')
        Error = $_.Exception.Message
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw
}
