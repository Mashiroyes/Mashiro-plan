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
    if ($installed.inspection.tasks.Count -ne 3 -or @($installed.inspection.tasks | Where-Object { -not $_.exists -or $_.state -ne 'Ready' }).Count -ne 0) { throw 'Installed calendar tasks were not verified.' }
    if ($installed.inspection.legacyTaskExists) { throw 'Legacy daily task remains after installation.' }
    if ($installed.inspection.tasks[0].triggerClass -ne 'MSFT_TaskWeeklyTrigger' -or $installed.inspection.tasks[0].xml -notmatch '<Monday') { throw 'Installed weekly trigger is incorrect.' }
    if ($installed.inspection.tasks[1].xml -notmatch '<December' -or $installed.inspection.tasks[2].xml -match '<February') { throw 'Installed monthly or yearly calendar trigger is incorrect.' }
    $installedPlugin = Join-Path $installed.runtimeRoot 'plugin'
    $launcher = Join-Path $installedPlugin 'windows\run-hidden-worker.vbs'
    $installedWorker = Join-Path $installedPlugin 'windows\english-skills-worker.ps1'
    $pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
    & (Join-Path $env:SystemRoot 'System32\cscript.exe') //nologo $launcher $pwshPath $installedWorker $installedPlugin $db week dry-run
    if ($LASTEXITCODE -ne 0) { throw 'Hidden launcher did not complete a dry-run worker successfully.' }
    Write-Output (@{ ok = $true; taskNames = $installed.taskNames } | ConvertTo-Json -Compress)
} finally {
    & pwsh -NoProfile -File $installer -Action Uninstall -SourcePluginRoot $pluginRoot -SqlitePath $db -RuntimeBase $runtime -TaskSuffix $suffix | Out-Null
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
