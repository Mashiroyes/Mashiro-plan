$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = Join-Path $env:TEMP ('english-skills-windows-' + [guid]::NewGuid().ToString('N'))
$db = Join-Path $tempRoot 'planner.sqlite'
$runtime = Join-Path $tempRoot 'runtime'
$suffix = '-Test-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$installer = Join-Path $pluginRoot 'windows\install-english-skills.ps1'
$worker = Join-Path $pluginRoot 'windows\english-skills-worker.ps1'
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null
try {
    $planner = Join-Path $pluginRoot 'planner\planner.py'
    $env:OPENCLAW_PLANNER_DB_PATH = $db
    $reviewState = @{
        version = 1
        videos = @(
            @{ number = 12; title = 'What staying up all night does to your brain - Anna Rothschild'; studiedOn = '2026-09-20'; reviewDates = @('2026-09-22','2026-09-27','2026-10-11','2026-11-19') },
            @{ number = 9; title = 'Not due today'; studiedOn = '2026-09-19'; reviewDates = @('2026-09-21','2026-09-26','2026-10-10','2026-11-18') }
        )
    }
    $reviewPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($reviewState | ConvertTo-Json -Compress -Depth 8)))
    & python $planner set-plugin-state --plugin-id mashirobot-plugin-language --state-key 'teded-listening:v1' --payload-base64 $reviewPayload | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to seed TED-Ed review state.' }
    $currentMonth = (& pwsh -NoProfile -File $worker -PluginRoot $pluginRoot -SqlitePath $db -Now '2026-09-22T10:00:00+08:00' -PeriodType current-month -DryRun | ConvertFrom-Json)
    if ($currentMonth.duePeriods.Count -ne 1 -or $currentMonth.duePeriods[0].fromDate -ne '2026-09-01' -or $currentMonth.duePeriods[0].toDate -ne '2026-09-22' -or $currentMonth.duePeriods[0].periodKey -ne 'month-to-date:2026-09-22') { throw 'Current-month daily range is incorrect.' }
    if ($currentMonth.results[0].message -notmatch '^今日英语学习计划：' -or $currentMonth.results[0].message -match 'TED-Ed') { throw 'The daily English learning-plan message must be explicit and independent from the TED-Ed review message.' }
    if ($currentMonth.results[0].reviewMessage -notmatch '今日 TED-Ed 复习（1.5倍速）' -or $currentMonth.results[0].reviewMessage -notmatch '#12 What staying up all night does to your brain' -or $currentMonth.results[0].reviewMessage -match 'Not due today') { throw 'Current-month notification did not include only today''s due TED-Ed videos.' }
    $nothingDue = (& pwsh -NoProfile -File $worker -PluginRoot $pluginRoot -SqlitePath $db -Now '2026-09-23T10:00:00+08:00' -PeriodType current-month -DryRun | ConvertFrom-Json)
    if ($nothingDue.results[0].reviewMessage -notmatch '今日无 TED-Ed 复习。') { throw 'Current-month notification did not state that no TED-Ed review was due.' }
    $year = (& pwsh -NoProfile -File $worker -PluginRoot $pluginRoot -SqlitePath $db -Now '2027-01-01T11:00:00+08:00' -DryRun | ConvertFrom-Json)
    if ($year.duePeriods.Count -ne 2 -or @($year.duePeriods.periodType) -notcontains 'month' -or @($year.duePeriods.periodType) -notcontains 'year') { throw 'January 1 due periods are incorrect.' }
    foreach ($result in $year.results) { if ($result.action -ne 'dry-run' -or -not (Test-Path -LiteralPath $result.mediaPath)) { throw 'Dry-run did not render each due chart.' } }
    $week = (& pwsh -NoProfile -File $worker -PluginRoot $pluginRoot -SqlitePath $db -Now '2026-08-03T11:00:00+08:00' -DryRun | ConvertFrom-Json)
    if ($week.duePeriods.Count -ne 1 -or $week.duePeriods[0].periodType -ne 'week') { throw 'Monday due period is incorrect.' }
    $weeklyCatchup = (& pwsh -NoProfile -File $worker -PluginRoot $pluginRoot -SqlitePath $db -Now '2026-08-04T11:00:00+08:00' -PeriodType week -DryRun | ConvertFrom-Json)
    if ($weeklyCatchup.duePeriods.Count -ne 1 -or $weeklyCatchup.duePeriods[0].fromDate -ne '2026-07-27' -or $weeklyCatchup.duePeriods[0].toDate -ne '2026-08-02') { throw 'Weekly catch-up range is incorrect.' }
    $monthlyCatchup = (& pwsh -NoProfile -File $worker -PluginRoot $pluginRoot -SqlitePath $db -Now '2026-09-02T11:00:00+08:00' -PeriodType month -DryRun | ConvertFrom-Json)
    if ($monthlyCatchup.duePeriods.Count -ne 1 -or $monthlyCatchup.duePeriods[0].fromDate -ne '2026-08-01' -or $monthlyCatchup.duePeriods[0].toDate -ne '2026-08-31') { throw 'Monthly catch-up range is incorrect.' }
    $yearlyCatchup = (& pwsh -NoProfile -File $worker -PluginRoot $pluginRoot -SqlitePath $db -Now '2027-01-02T11:00:00+08:00' -PeriodType year -DryRun | ConvertFrom-Json)
    if ($yearlyCatchup.duePeriods.Count -ne 1 -or $yearlyCatchup.duePeriods[0].fromDate -ne '2026-01-01' -or $yearlyCatchup.duePeriods[0].toDate -ne '2026-12-31') { throw 'Yearly catch-up range is incorrect.' }
    $installed = (& pwsh -NoProfile -File $installer -Action Install -SourcePluginRoot $pluginRoot -SqlitePath $db -RuntimeBase $runtime -TaskSuffix $suffix | ConvertFrom-Json)
    if ($installed.inspection.tasks.Count -ne 4 -or @($installed.inspection.tasks | Where-Object { -not $_.exists -or $_.state -ne 'Ready' }).Count -ne 0) { throw 'Installed calendar tasks were not verified.' }
    if ($installed.inspection.legacyTaskExists) { throw 'Legacy daily task remains after installation.' }
    $dailyTask = $installed.inspection.tasks[0]
    $dailyClassOk = $dailyTask.triggerClass -eq 'MSFT_TaskDailyTrigger'
    $dailyHourOk = ([datetimeoffset]$dailyTask.startBoundary).Hour -eq 10
    $dailyIntervalOk = ([string]$dailyTask.xml).Contains('<DaysInterval>1</DaysInterval>')
    if (-not ($dailyClassOk -and $dailyHourOk -and $dailyIntervalOk)) { throw ("Installed daily current-month trigger is incorrect: class=$dailyClassOk hour=$dailyHourOk interval=$dailyIntervalOk " + ($dailyTask | ConvertTo-Json -Compress -Depth 5)) }
    if ($installed.inspection.tasks[1].triggerClass -ne 'MSFT_TaskWeeklyTrigger' -or $installed.inspection.tasks[1].xml -notmatch '<Monday') { throw 'Installed weekly trigger is incorrect.' }
    if ($installed.inspection.tasks[2].xml -notmatch '<December' -or $installed.inspection.tasks[3].xml -match '<February') { throw 'Installed monthly or yearly calendar trigger is incorrect.' }
    $planRoot = Split-Path -Parent (Split-Path -Parent $pluginRoot)
    $jobCli = Join-Path $planRoot 'core\control\job-cli.mjs'
    $jobs = @(& node $jobCli list $db | ConvertFrom-Json)
    $englishJobs = @($jobs | Where-Object { $_.owner -eq 'mashirobot-plugin-language' })
    if ($englishJobs.Count -ne 4) { throw 'English task desired-state records were not created.' }
    foreach ($job in $englishJobs) {
        $task = Get-ScheduledTask -TaskName $job.taskName -ErrorAction Stop
        $action = @($task.Actions)[0]
        if ([string]$job.payload.execution.executable -ne [string]$action.Execute -or [string]$job.payload.execution.arguments -ne [string]$action.Arguments) {
            throw "English desired-state action does not match the installed task: $($job.taskName)"
        }
        if ([IO.Path]::GetFileName([string]$job.payload.execution.executable) -ne 'wscript.exe' -or [string]$job.payload.execution.arguments -notmatch 'run-hidden-worker\.vbs') {
            throw "English desired-state action does not use the hidden launcher: $($job.taskName)"
        }
    }
    $installedPlugin = Join-Path $installed.runtimeRoot 'plugin'
    if (Test-Path -LiteralPath (Join-Path $installedPlugin 'windows\windows-notification.ps1')) { throw 'Installed English statistics runtime still contains the Windows notification helper.' }
    $launcher = Join-Path $installedPlugin 'windows\run-hidden-worker.vbs'
    $installedWorker = Join-Path $installedPlugin 'windows\english-skills-worker.ps1'
    $installedWorkerSource = Get-Content -LiteralPath $installedWorker -Raw -Encoding UTF8
    if ($installedWorkerSource -match 'Show-MashiroWindowsChart|windows-notification\.ps1') { throw 'Installed English statistics worker still contains a Windows popup call.' }
    if ($installedWorkerSource -notmatch 'deliveryStatus' -or $installedWorkerSource -notmatch 'result\.messageId' -or $installedWorkerSource -notmatch 'Invoke-WeixinSend') { throw 'Installed English worker does not verify WeChat delivery evidence.' }
    $pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    & (Join-Path $env:SystemRoot 'System32\cscript.exe') //nologo $launcher $pwshPath $installedWorker $installedPlugin $db week 'english-skills:test-week' 1 dry-run
    if ($LASTEXITCODE -ne 0) { throw 'Hidden launcher did not complete a dry-run worker successfully.' }
    Write-Output (@{ ok = $true; taskNames = $installed.taskNames } | ConvertTo-Json -Compress)
} finally {
    & pwsh -NoProfile -File $installer -Action Uninstall -SourcePluginRoot $pluginRoot -SqlitePath $db -RuntimeBase $runtime -TaskSuffix $suffix | Out-Null
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
