param(
    [Parameter(Mandatory = $true)][ValidateSet('Inspect','Install','Uninstall')][string]$Action,
    [string]$SourcePluginRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$SqlitePath,
    [string]$RuntimeBase = (Join-Path $env:LOCALAPPDATA 'MashiroBot\financial-report'),
    [string]$TaskSuffix = ''
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$SourcePluginRoot = [IO.Path]::GetFullPath($SourcePluginRoot)
$RuntimeBase = [IO.Path]::GetFullPath($RuntimeBase)
$allowedBase = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'MashiroBot\financial-report'))
if (-not $RuntimeBase.StartsWith($allowedBase, [StringComparison]::OrdinalIgnoreCase) -and -not $TaskSuffix.StartsWith('-Test-')) {
    throw "RuntimeBase must stay under $allowedBase unless an isolated -Test- suffix is used."
}
$RuntimeRoot = Join-Path $RuntimeBase 'runtime-v1'
$planRoot = Split-Path -Parent (Split-Path -Parent $SourcePluginRoot)
if (-not $SqlitePath) { $SqlitePath = Join-Path $planRoot 'sqlite\openclaw-planner.sqlite' }
$SqlitePath = [IO.Path]::GetFullPath($SqlitePath)
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$openClawPath = 'D:\Program\nodejs\npm_global24\openclaw.cmd'
$taskNames = @(
    "MashiroBot Financial Report Daily$TaskSuffix",
    "MashiroBot Prospectus Tuesday Friday$TaskSuffix",
    "MashiroBot Financial Report Feedback$TaskSuffix"
)

function Get-TaskSnapshot {
    foreach ($name in $taskNames) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task) {
            [xml]$xml = Export-ScheduledTask -TaskName $name
            [ordered]@{ name = $name; exists = $true; state = [string]$task.State; xml = $xml.OuterXml }
        } else { [ordered]@{ name = $name; exists = $false } }
    }
}

function Get-RuntimeHashes {
    if (-not (Test-Path -LiteralPath $RuntimeRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $RuntimeRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{ relativePath = [IO.Path]::GetRelativePath($RuntimeRoot, $_.FullName); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
}

function Get-DatabaseStatus {
    if (-not (Test-Path -LiteralPath $SqlitePath)) { return [ordered]@{ exists = $false; path = $SqlitePath } }
    $script = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);const r=d.prepare('PRAGMA integrity_check').get();d.close();console.log(JSON.stringify(r));"
    $raw = & $nodePath -e $script $SqlitePath 2>&1
    if ($LASTEXITCODE -ne 0) { return [ordered]@{ exists = $true; path = $SqlitePath; integrity = 'error'; detail = ($raw -join ' ') } }
    $value = ($raw -join '') | ConvertFrom-Json
    return [ordered]@{ exists = $true; path = $SqlitePath; integrity = $value.integrity_check }
}

function Get-Inspection {
    [ordered]@{
        action = 'Inspect'; sourcePluginRoot = $SourcePluginRoot; runtimeBase = $RuntimeBase; runtimeRoot = $RuntimeRoot
        sqlite = Get-DatabaseStatus; pwshPath = $pwshPath; nodePath = $nodePath
        openClawPath = $openClawPath; openClawAvailable = (Test-Path -LiteralPath $openClawPath)
        gatewayAvailable = [bool](Get-Process -Name node -ErrorAction SilentlyContinue)
        taskNames = $taskNames; tasks = @(Get-TaskSnapshot); runtimeHashes = @(Get-RuntimeHashes)
        prospectiveChanges = @('backup SQLite set', 'copy immutable runtime-v1', 'initialize prefixed tables', 'register three current-user tasks')
    }
}

if ($Action -eq 'Inspect') { Get-Inspection | ConvertTo-Json -Depth 9; exit 0 }

if ($Action -eq 'Uninstall') {
    foreach ($name in $taskNames) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $RuntimeRoot) {
        $resolved = [IO.Path]::GetFullPath($RuntimeRoot)
        if (-not $resolved.StartsWith($RuntimeBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing runtime deletion outside RuntimeBase.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    [ordered]@{ action = 'Uninstall'; removedTasks = $taskNames; removedRuntime = $RuntimeRoot } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not (Test-Path -LiteralPath $SourcePluginRoot -PathType Container)) { throw "Source plugin not found: $SourcePluginRoot" }
[IO.Directory]::CreateDirectory((Split-Path -Parent $SqlitePath)) | Out-Null
if (Test-Path -LiteralPath $SqlitePath) {
    $checkpointScript = "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify({checkpoint:d.prepare('PRAGMA wal_checkpoint(FULL)').all(),integrity:d.prepare('PRAGMA integrity_check').get()}));d.close();"
    $check = & $nodePath -e $checkpointScript $SqlitePath 2>&1
    if ($LASTEXITCODE -ne 0 -or (($check -join '') | ConvertFrom-Json).integrity.integrity_check -ne 'ok') { throw 'SQLite checkpoint or integrity check failed before migration.' }
    $backupDir = Join-Path $planRoot ('sqlite\backups\financial-report-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    [IO.Directory]::CreateDirectory($backupDir) | Out-Null
    foreach ($candidate in @($SqlitePath, "$SqlitePath-wal", "$SqlitePath-shm")) {
        if (Test-Path -LiteralPath $candidate) { Copy-Item -LiteralPath $candidate -Destination $backupDir -Force }
    }
}

[IO.Directory]::CreateDirectory($RuntimeBase) | Out-Null
$staging = Join-Path $RuntimeBase ('staging-' + [guid]::NewGuid().ToString('N'))
$stagingPlugin = Join-Path $staging 'plugin'
[IO.Directory]::CreateDirectory($stagingPlugin) | Out-Null
try {
    foreach ($directory in @('runtime','core','curriculum','windows','help')) {
        Copy-Item -LiteralPath (Join-Path $SourcePluginRoot $directory) -Destination $stagingPlugin -Recurse -Force
    }
    foreach ($file in @('plugin.json','index.mjs','README.md')) { Copy-Item -LiteralPath (Join-Path $SourcePluginRoot $file) -Destination $stagingPlugin -Force }
    $sourceFiles = Get-ChildItem -LiteralPath $SourcePluginRoot -File -Recurse | Where-Object { $_.FullName -notmatch '\\tests\\' }
    foreach ($source in $sourceFiles) {
        $relative = [IO.Path]::GetRelativePath($SourcePluginRoot, $source.FullName)
        $copied = Join-Path $stagingPlugin $relative
        if (Test-Path -LiteralPath $copied) {
            if ((Get-FileHash $source.FullName -Algorithm SHA256).Hash -ne (Get-FileHash $copied -Algorithm SHA256).Hash) { throw "Runtime hash mismatch: $relative" }
        }
    }
    if (Test-Path -LiteralPath $RuntimeRoot) { Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force }
    Move-Item -LiteralPath $staging -Destination $RuntimeRoot
} catch {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    throw
}

$cliPath = Join-Path $RuntimeRoot 'plugin\runtime\cli.mjs'
$installedDate = (Get-Date).ToString('yyyy-MM-dd')
$init = & $nodePath $cliPath init --sqlite-path $SqlitePath --account-id 'ea8fd13b2100-im-bot' --conversation-id 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat' --installed-date $installedDate 2>&1
if ($LASTEXITCODE -ne 0) { throw ($init -join [Environment]::NewLine) }

$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
function Register-FinancialTask([string]$Name, [string]$Worker, [string]$Arguments, $Trigger) {
    $actionObject = New-ScheduledTaskAction -Execute $wscriptPath -Argument $Arguments
    $definition = New-ScheduledTask -Action $actionObject -Trigger $Trigger -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $Name -InputObject $definition -Force | Out-Null
    Enable-ScheduledTask -TaskName $Name | Out-Null
}
$deliveryWorker = Join-Path $RuntimeRoot 'plugin\windows\delivery-worker.ps1'
$feedbackWorker = Join-Path $RuntimeRoot 'plugin\windows\feedback-worker.ps1'
$workerVbs = Join-Path $RuntimeRoot 'plugin\windows\run-worker.vbs'
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) { throw "Windows Script Host not found: $wscriptPath" }
if (-not (Test-Path -LiteralPath $workerVbs -PathType Leaf)) { throw "Hidden worker launcher not found: $workerVbs" }
function New-Repetition([string]$Interval, [string]$Duration) {
    return New-CimInstance -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskRepetitionPattern -ClientOnly -Property @{
        Interval = $Interval; Duration = $Duration; StopAtDurationEnd = $false
    }
}
$daily = @(
    New-ScheduledTaskTrigger -Daily -At '12:30'
    New-ScheduledTaskTrigger -Daily -At '18:30'
)
$weekly = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Tuesday,Friday -At '18:10'
$feedback = New-ScheduledTaskTrigger -Daily -At '00:00'
$feedback.Repetition = New-Repetition 'PT30M' 'P1D'
function New-VbsArguments([string]$Worker, [string]$CourseType = '') {
    return '"{0}" "{1}" "{2}" "{3}" "{4}" "{5}"' -f $workerVbs, $pwshPath, $Worker, $RuntimeRoot, $SqlitePath, $CourseType
}
Register-FinancialTask $taskNames[0] $deliveryWorker (New-VbsArguments $deliveryWorker 'financial_report') $daily
Register-FinancialTask $taskNames[1] $deliveryWorker (New-VbsArguments $deliveryWorker 'prospectus') $weekly
Register-FinancialTask $taskNames[2] $feedbackWorker (New-VbsArguments $feedbackWorker) $feedback

$inspection = Get-Inspection
foreach ($task in $inspection.tasks) {
    if (-not $task.exists -or $task.xml -notmatch [regex]::Escape($wscriptPath) -or $task.xml -notmatch 'run-worker.vbs' -or $task.xml -notmatch 'runtime-v1') { throw "Registered task verification failed: $($task.name)" }
}
[ordered]@{ action = 'Install'; runtimeRoot = $RuntimeRoot; sqlitePath = $SqlitePath; tasks = $taskNames; inspection = $inspection } | ConvertTo-Json -Depth 9
