$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $pluginRoot 'windows\install-financial-report.ps1'
$source = Get-Content -Raw -Encoding UTF8 $installer
foreach ($required in @('MashiroBot Financial Report Daily','MashiroBot Prospectus Tuesday Friday','MashiroBot Financial Report Feedback','runtime-v1','RunLevel Limited','StartWhenAvailable','WakeToRun','IgnoreNew','wscript.exe','run-worker.vbs','PT30M','12:30','18:30')) {
    if (-not $source.Contains($required)) { throw "installer missing contract: $required" }
}
if ($source -match 'Remove-Item\s+[^\r\n]*(?:USERPROFILE|HOME|~)') { throw 'unsafe broad removal found' }

$suffix = '-Test-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$tempBase = Join-Path $env:LOCALAPPDATA ('MashiroBot\financial-report\test-' + $suffix.Substring(6))
$tempDb = Join-Path $tempBase 'test.sqlite'
try {
    $inspect = & pwsh -NoProfile -File $installer -Action Inspect -SourcePluginRoot $pluginRoot -SqlitePath $tempDb -RuntimeBase $tempBase -TaskSuffix $suffix | ConvertFrom-Json
    if ($inspect.tasks.Count -ne 3) { throw 'Inspect did not report three tasks' }
    $installed = & pwsh -NoProfile -File $installer -Action Install -SourcePluginRoot $pluginRoot -SqlitePath $tempDb -RuntimeBase $tempBase -TaskSuffix $suffix | ConvertFrom-Json
    $feedbackName = "MashiroBot Financial Report Feedback$suffix"
    Start-ScheduledTask -TaskName $feedbackName
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $info = Get-ScheduledTaskInfo -TaskName $feedbackName
        $state = (Get-ScheduledTask -TaskName $feedbackName).State
    } while (($info.LastRunTime.Year -lt 2000 -or $state -eq 'Running') -and (Get-Date) -lt $deadline)
    if ($info.LastTaskResult -ne 0) { throw "isolated feedback task result was $($info.LastTaskResult)" }
    foreach ($name in $installed.tasks) {
        [xml]$xml = Export-ScheduledTask -TaskName $name
        if ([string]$xml.Task.Principals.Principal.RunLevel -eq 'HighestAvailable') { throw "task is not limited: $name" }
        if ($xml.OuterXml -notmatch 'runtime-v1') { throw "task does not use persistent runtime: $name" }
        $task = Get-ScheduledTask -TaskName $name
        if ($task.Actions[0].Execute -notmatch 'wscript\.exe$' -or $task.Actions[0].Arguments -notmatch 'run-worker\.vbs') { throw "task does not use hidden VBS launcher: $name" }
    }
    $dailyName = "MashiroBot Financial Report Daily$suffix"
    $dailyTriggers = (Get-ScheduledTask -TaskName $dailyName).Triggers
    if ($dailyTriggers.Count -ne 2 -or ($dailyTriggers.StartBoundary -notcontains '2026-08-09T12:30:00+08:00') -or ($dailyTriggers.StartBoundary -notcontains '2026-08-09T18:30:00+08:00')) { throw 'financial report triggers are not 12:30 and 18:30' }
    if ($dailyTriggers | Where-Object { $_.Repetition.Interval }) { throw 'financial report task must not repeat' }
    $feedbackTrigger = (Get-ScheduledTask -TaskName $feedbackName).Triggers[0]
    if ($feedbackTrigger.Repetition.Interval -ne 'PT30M') { throw 'feedback task must repeat every 30 minutes' }
    @{ ok = $true; tasks = $installed.tasks } | ConvertTo-Json -Compress
} finally {
    try { & pwsh -NoProfile -File $installer -Action Uninstall -SourcePluginRoot $pluginRoot -SqlitePath $tempDb -RuntimeBase $tempBase -TaskSuffix $suffix | Out-Null } catch {}
    if (Test-Path -LiteralPath $tempBase) {
        $resolved = [IO.Path]::GetFullPath($tempBase)
        $allowed = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'MashiroBot\financial-report'))
        if ($resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}
