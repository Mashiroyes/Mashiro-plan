[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Inspect', 'Uninstall')][string]$Action,
    [string]$SqlitePath = '',
    [string]$RuntimeDescriptorPath = '',
    [string]$SourcePluginRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PlanRoot = Split-Path -Parent (Split-Path -Parent $SourcePluginRoot)
$Sqlite = if ($SqlitePath) { [IO.Path]::GetFullPath($SqlitePath) } else { Join-Path $PlanRoot 'sqlite\openclaw-planner.sqlite' }
$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'MashiroBot\loot\runtime-v1'
$RuntimePlugin = Join-Path $RuntimeRoot 'plugin'
$EveningTask = 'MashiroBot Loot Evening'
$MorningTask = 'MashiroBot Loot Morning'
$OldTasks = @('OpenClaw-Daily-Water-1000', 'OpenClaw-Daily-EnglishJournal-2100')
$Runtime = if ($RuntimeDescriptorPath) { Get-Content -LiteralPath ([IO.Path]::GetFullPath($RuntimeDescriptorPath)) -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$Pwsh = if ($Runtime) { [string]$Runtime.pwshPath } else { (Get-Command pwsh.exe -ErrorAction Stop).Source }
$Node = if ($Runtime) { [string]$Runtime.nodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
$JobCli = Join-Path $PlanRoot 'core\control\job-cli.mjs'

function Invoke-JobCli([string]$Mode,[hashtable]$Payload) {
    $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Payload|ConvertTo-Json -Compress -Depth 10)))
    $raw=& $Node $JobCli $Mode $Sqlite $encoded 2>&1
    if($LASTEXITCODE-ne 0){throw($raw-join[Environment]::NewLine)}
    return (($raw-join'')|ConvertFrom-Json)
}

function Get-TaskProjection {
    param([string]$Name)
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task) { return [ordered]@{ name = $Name; exists = $false } }
    $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue
    [ordered]@{
        name = $Name; exists = $true; state = [string]$task.State
        nextRun = if ($info) { $info.NextRunTime.ToString('o') } else { $null }
        execute = $task.Actions.Execute; arguments = $task.Actions.Arguments
        triggers = @($task.Triggers | ForEach-Object { $_.StartBoundary })
    }
}

function Remove-TaskIfPresent {
    param([string]$Name)
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
}

function Register-LootTasks {
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $eveningJob='loot:evening';$morningJob='loot:morning'
    $eveningArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action Evening -SqlitePath "{1}" -NodePath "{2}" -JobId "{3}" -JobVersion 2' -f (Join-Path $RuntimePlugin 'windows\loot-worker.ps1'), $Sqlite, $Node, $eveningJob
    $morningArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action Morning -SqlitePath "{1}" -NodePath "{2}" -JobId "{3}" -JobVersion 1' -f (Join-Path $RuntimePlugin 'windows\loot-worker.ps1'), $Sqlite, $Node, $morningJob
    $reconcileArguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Action','Install','-SqlitePath',$Sqlite,'-SourcePluginRoot',$SourcePluginRoot)
    if($RuntimeDescriptorPath){$reconcileArguments+=@('-RuntimeDescriptorPath',[IO.Path]::GetFullPath($RuntimeDescriptorPath))}
    $reconcile=@{executable=$Pwsh;argumentList=$reconcileArguments}
    Invoke-JobCli 'upsert' @{jobId=$eveningJob;version=2;owner='mashirobot-plugin-loot';kind='loot-evening';taskName=$EveningTask;runAt=([DateTimeOffset]::Now.Date.AddHours(21).AddMinutes(15).ToString('o'));recurrence=@{dailyTimes=@('21:15','21:50')};payload=@{execution=@{executable=$Pwsh;arguments=$eveningArguments};reconcile=$reconcile}}|Out-Null
    Invoke-JobCli 'upsert' @{jobId=$morningJob;version=1;owner='mashirobot-plugin-loot';kind='loot-morning';taskName=$MorningTask;runAt=([DateTimeOffset]::Now.Date.AddDays(1).AddHours(10).ToString('o'));recurrence=@{dailyTimes=@('10:00')};payload=@{execution=@{executable=$Pwsh;arguments=$morningArguments};reconcile=$reconcile}}|Out-Null
    $eveningAction = New-ScheduledTaskAction -Execute $Pwsh -Argument $eveningArguments
    $morningAction = New-ScheduledTaskAction -Execute $Pwsh -Argument $morningArguments
    $eveningTriggers = @(15, 50) | ForEach-Object { New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours(21).AddMinutes($_)) }
    $morningTrigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours(10))
    Register-ScheduledTask -TaskName $EveningTask -Action $eveningAction -Trigger $eveningTriggers -Settings $settings -Principal $principal -Force | Out-Null
    Register-ScheduledTask -TaskName $MorningTask -Action $morningAction -Trigger $morningTrigger -Settings $settings -Principal $principal -Force | Out-Null
}

if ($Action -eq 'Uninstall') {
    try { Invoke-JobCli 'cancel' @{jobId='loot:evening'} | Out-Null; Invoke-JobCli 'cancel' @{jobId='loot:morning'} | Out-Null } catch {}
    Remove-TaskIfPresent $EveningTask
    Remove-TaskIfPresent $MorningTask
    if (Test-Path -LiteralPath $RuntimeRoot) { Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force }
    [ordered]@{ ok = $true; action = 'Uninstall'; tasks = @($EveningTask, $MorningTask) } | ConvertTo-Json -Depth 8
    exit 0
}

if ($Action -eq 'Install') {
    if (-not (Test-Path -LiteralPath $SourcePluginRoot -PathType Container)) { throw "Source plugin root not found: $SourcePluginRoot" }
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
    if (Test-Path -LiteralPath $RuntimePlugin) { Remove-Item -LiteralPath $RuntimePlugin -Recurse -Force }
    Copy-Item -LiteralPath $SourcePluginRoot -Destination $RuntimePlugin -Recurse -Force
    $dbCli = Join-Path $SourcePluginRoot 'core\database-cli.mjs'
    & $Node $dbCli --sqlite $Sqlite | Out-Null
    foreach ($oldTask in $OldTasks) { Remove-TaskIfPresent $oldTask }
    Register-LootTasks
}

[ordered]@{
    ok = $true; action = $Action; sqlitePath = $Sqlite; runtimePlugin = $RuntimePlugin
    oldTasks = @($OldTasks | ForEach-Object { Get-TaskProjection $_ })
    tasks = @($EveningTask, $MorningTask) | ForEach-Object { Get-TaskProjection $_ }
} | ConvertTo-Json -Depth 10
