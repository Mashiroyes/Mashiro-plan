param(
    [Parameter(Mandatory = $true)][ValidateSet('Inspect','Install','Uninstall')][string]$Action,
    [string]$SourcePluginRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$SqlitePath,
    [string]$RuntimeBase = (Join-Path $env:LOCALAPPDATA 'MashiroBot\english-skills'),
    [string]$TaskSuffix = ''
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$SourcePluginRoot = [IO.Path]::GetFullPath($SourcePluginRoot)
$RuntimeBase = [IO.Path]::GetFullPath($RuntimeBase)
$allowedBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'MashiroBot\english-skills'))
if (-not $RuntimeBase.StartsWith($allowedBase, [StringComparison]::OrdinalIgnoreCase) -and -not $TaskSuffix.StartsWith('-Test-')) { throw "RuntimeBase must stay under $allowedBase unless an isolated test suffix is used." }
$RuntimeRoot = Join-Path $RuntimeBase 'runtime-v1'
$RuntimePlugin = Join-Path $RuntimeRoot 'plugin'
$taskDefinitions = @(
    [ordered]@{ Name = "MashiroBot English Skills Weekly$TaskSuffix"; PeriodType = 'week'; TriggerType = 'weekly' },
    [ordered]@{ Name = "MashiroBot English Skills Monthly$TaskSuffix"; PeriodType = 'month'; TriggerType = 'monthly' },
    [ordered]@{ Name = "MashiroBot English Skills Yearly$TaskSuffix"; PeriodType = 'year'; TriggerType = 'yearly' }
)
$legacyTaskName = "MashiroBot English Skills Dashboard$TaskSuffix"
$planRoot = Split-Path -Parent (Split-Path -Parent $SourcePluginRoot)
if (-not $SqlitePath) { $SqlitePath = Join-Path $planRoot 'sqlite\openclaw-planner.sqlite' }
$SqlitePath = [IO.Path]::GetFullPath($SqlitePath)
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$python = (Get-Command python.exe -ErrorAction Stop).Source
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

function Get-Inspection {
    $tasks = foreach ($definition in $taskDefinitions) {
        $task = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
        $trigger = if ($task) { @($task.Triggers)[0] } else { $null }
        [ordered]@{
            name = $definition.Name; periodType = $definition.PeriodType; exists = [bool]$task
            state = if ($task) { [string]$task.State } else { $null }
            triggerClass = if ($trigger) { [string]$trigger.CimClass.CimClassName } else { $null }
            startBoundary = if ($trigger) { [string]$trigger.StartBoundary } else { $null }
            daysOfWeek = if ($trigger -and $trigger.PSObject.Properties.Name -contains 'DaysOfWeek') { $trigger.DaysOfWeek } else { $null }
            daysOfMonth = if ($trigger -and $trigger.PSObject.Properties.Name -contains 'DaysOfMonth') { $trigger.DaysOfMonth } else { $null }
            monthOfYear = if ($trigger -and $trigger.PSObject.Properties.Name -contains 'MonthOfYear') { $trigger.MonthOfYear } else { $null }
            xml = if ($task) { ([xml](Export-ScheduledTask -TaskName $definition.Name)).OuterXml } else { $null }
        }
    }
    [ordered]@{
        action = 'Inspect'; tasks = @($tasks); legacyTaskName = $legacyTaskName
        legacyTaskExists = [bool](Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue)
        runtimeRoot = $RuntimeRoot; runtimeExists = (Test-Path -LiteralPath $RuntimeRoot -PathType Container)
        sqlitePath = $SqlitePath; sqliteExists = (Test-Path -LiteralPath $SqlitePath -PathType Leaf)
    }
}

if ($Action -eq 'Inspect') { Get-Inspection | ConvertTo-Json -Depth 7; exit 0 }
if ($Action -eq 'Uninstall') {
    foreach ($definition in $taskDefinitions) { Unregister-ScheduledTask -TaskName $definition.Name -Confirm:$false -ErrorAction SilentlyContinue }
    Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction SilentlyContinue
    [ordered]@{ action = 'Uninstall'; removedTasks = @($taskDefinitions.Name) + $legacyTaskName; runtimePreserved = $RuntimeRoot } | ConvertTo-Json -Depth 4
    exit 0
}

if (-not (Test-Path -LiteralPath $SourcePluginRoot -PathType Container)) { throw "Source plugin not found: $SourcePluginRoot" }
[IO.Directory]::CreateDirectory($RuntimeBase) | Out-Null
if (Test-Path -LiteralPath $SqlitePath) {
    $checkScript = "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('PRAGMA wal_checkpoint(FULL)').fetchall(); print(d.execute('PRAGMA integrity_check').fetchone()[0]); d.close()"
    $integrity = & $python -c $checkScript $SqlitePath 2>&1
    if ($LASTEXITCODE -ne 0 -or ($integrity -join '').Trim() -ne 'ok') { throw 'SQLite checkpoint or integrity check failed before migration.' }
    $backup = Join-Path $planRoot ('sqlite\backups\english-skills-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    foreach ($candidate in @($SqlitePath, "$SqlitePath-wal", "$SqlitePath-shm")) {
        if (Test-Path -LiteralPath $candidate) { Copy-Item -LiteralPath $candidate -Destination $backup -Force }
    }
}

$staging = Join-Path $RuntimeBase ('staging-' + [guid]::NewGuid().ToString('N'))
$stagingPlugin = Join-Path $staging 'plugin'
$languagePluginRoot = Join-Path (Split-Path -Parent $SourcePluginRoot) 'mashirobot-plugin-language'
[IO.Directory]::CreateDirectory($stagingPlugin) | Out-Null
foreach ($directory in @('planner','config','windows')) { Copy-Item -LiteralPath (Join-Path $SourcePluginRoot $directory) -Destination $stagingPlugin -Recurse -Force }
foreach ($file in @('plugin.json','README.md')) { Copy-Item -LiteralPath (Join-Path $SourcePluginRoot $file) -Destination $stagingPlugin -Force }
if (-not (Test-Path -LiteralPath $languagePluginRoot -PathType Container)) { throw "Language plugin not found: $languagePluginRoot" }
Copy-Item -LiteralPath $languagePluginRoot -Destination $staging -Recurse -Force
if (Test-Path -LiteralPath $RuntimeRoot) {
    $archived = Join-Path $RuntimeBase ('runtime-v1.previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Move-Item -LiteralPath $RuntimeRoot -Destination $archived
}
Move-Item -LiteralPath $staging -Destination $RuntimeRoot

$env:OPENCLAW_PLANNER_DB_PATH = $SqlitePath
$initialized = & $python (Join-Path $RuntimePlugin 'planner\planner.py') init 2>&1
if ($LASTEXITCODE -ne 0) { throw ($initialized -join [Environment]::NewLine) }

$worker = Join-Path $RuntimePlugin 'windows\english-skills-worker.ps1'
$launcher = Join-Path $RuntimePlugin 'windows\run-hidden-worker.vbs'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$startBoundary = (Get-Date).Date.AddHours(11).ToString('yyyy-MM-ddTHH:mm:sszzz')
function Add-TaskXmlElement($Xml, $Parent, [string]$Name, [string]$Text = '') {
    $element = $Xml.CreateElement($Name, 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    if ($Text) { $element.InnerText = $Text }
    $null = $Parent.AppendChild($element)
    return $element
}
function Set-EnglishSkillsCalendarTrigger([string]$TaskName, [string]$TriggerType) {
    [xml]$xml = Export-ScheduledTask -TaskName $TaskName
    $namespace = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $namespace.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $triggers = $xml.SelectSingleNode('/t:Task/t:Triggers', $namespace)
    $triggers.RemoveAll()
    $calendar = Add-TaskXmlElement $xml $triggers 'CalendarTrigger'
    $null = Add-TaskXmlElement $xml $calendar 'StartBoundary' $startBoundary
    $null = Add-TaskXmlElement $xml $calendar 'Enabled' 'true'
    if ($TriggerType -eq 'weekly') {
        $schedule = Add-TaskXmlElement $xml $calendar 'ScheduleByWeek'
        $days = Add-TaskXmlElement $xml $schedule 'DaysOfWeek'
        $null = Add-TaskXmlElement $xml $days 'Monday'
        $null = Add-TaskXmlElement $xml $schedule 'WeeksInterval' '1'
    } else {
        $schedule = Add-TaskXmlElement $xml $calendar 'ScheduleByMonth'
        $days = Add-TaskXmlElement $xml $schedule 'DaysOfMonth'
        $null = Add-TaskXmlElement $xml $days 'Day' '1'
        $months = Add-TaskXmlElement $xml $schedule 'Months'
        $monthNames = if ($TriggerType -eq 'yearly') { @('January') } else { @('January','February','March','April','May','June','July','August','September','October','November','December') }
        foreach ($monthName in $monthNames) { $null = Add-TaskXmlElement $xml $months $monthName }
    }
    Register-ScheduledTask -TaskName $TaskName -Xml $xml.OuterXml -Force | Out-Null
}
foreach ($taskDefinition in $taskDefinitions) {
    $arguments = '"{0}" "{1}" "{2}" "{3}" "{4}" "{5}"' -f $launcher, $pwsh, $worker, $RuntimePlugin, $SqlitePath, $taskDefinition.PeriodType
    $actionObject = New-ScheduledTaskAction -Execute $wscript -Argument $arguments
    $temporaryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(10)
    $scheduledTask = New-ScheduledTask -Action $actionObject -Trigger $temporaryTrigger -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $taskDefinition.Name -InputObject $scheduledTask -Force | Out-Null
    Set-EnglishSkillsCalendarTrigger $taskDefinition.Name $taskDefinition.TriggerType
    Enable-ScheduledTask -TaskName $taskDefinition.Name | Out-Null
}
$inspection = Get-Inspection
foreach ($task in $inspection.tasks) {
    if (-not $task.exists -or $task.state -ne 'Ready' -or $task.startBoundary -notmatch 'T11:00:00' -or $task.xml -notmatch 'run-hidden-worker.vbs' -or $task.xml -notmatch 'runtime-v1' -or $task.xml -notmatch ('&quot;' + $task.periodType + '&quot;|"' + $task.periodType + '"')) { throw "English skills task verification failed: $($task.name)" }
}
if ($inspection.tasks[0].triggerClass -ne 'MSFT_TaskWeeklyTrigger' -or $inspection.tasks[0].xml -notmatch '<ScheduleByWeek>' -or $inspection.tasks[0].xml -notmatch '<Monday') { throw 'English skills weekly calendar trigger is incorrect.' }
if ($inspection.tasks[1].xml -notmatch '<ScheduleByMonth>' -or $inspection.tasks[1].xml -notmatch '<Day>1</Day>' -or $inspection.tasks[1].xml -notmatch '<January' -or $inspection.tasks[1].xml -notmatch '<December') { throw 'English skills monthly calendar trigger is incorrect.' }
if ($inspection.tasks[2].xml -notmatch '<ScheduleByMonth>' -or $inspection.tasks[2].xml -notmatch '<Day>1</Day>' -or $inspection.tasks[2].xml -notmatch '<January' -or $inspection.tasks[2].xml -match '<February') { throw 'English skills yearly calendar trigger is incorrect.' }
Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false -ErrorAction SilentlyContinue
$inspection = Get-Inspection
[ordered]@{ action = 'Install'; taskNames = @($taskDefinitions.Name); runtimeRoot = $RuntimeRoot; sqlitePath = $SqlitePath; inspection = $inspection } | ConvertTo-Json -Depth 9
