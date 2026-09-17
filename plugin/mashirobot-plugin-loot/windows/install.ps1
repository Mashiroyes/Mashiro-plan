[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Install', 'Inspect', 'Uninstall')][string]$Action,
    [string]$SqlitePath = '',
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
$Pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$Node = (Get-Command node.exe -ErrorAction Stop).Source

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
    $eveningArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action Evening -SqlitePath "{1}" -NodePath "{2}"' -f (Join-Path $RuntimePlugin 'windows\loot-worker.ps1'), $Sqlite, $Node
    $morningArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action Morning -SqlitePath "{1}" -NodePath "{2}"' -f (Join-Path $RuntimePlugin 'windows\loot-worker.ps1'), $Sqlite, $Node
    $eveningAction = New-ScheduledTaskAction -Execute $Pwsh -Argument $eveningArguments
    $morningAction = New-ScheduledTaskAction -Execute $Pwsh -Argument $morningArguments
    $eveningTriggers = @(21, 21, 21, 21, 21, 21, 22) | ForEach-Object -Begin { $index = 0 } -Process {
        $minute = if ($index -lt 6) { $index * 10 } else { 0 }
        $index += 1
        New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours($_).AddMinutes($minute))
    }
    $morningTrigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours(10))
    Register-ScheduledTask -TaskName $EveningTask -Action $eveningAction -Trigger $eveningTriggers -Settings $settings -Principal $principal -Force | Out-Null
    Register-ScheduledTask -TaskName $MorningTask -Action $morningAction -Trigger $morningTrigger -Settings $settings -Principal $principal -Force | Out-Null
}

if ($Action -eq 'Uninstall') {
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
