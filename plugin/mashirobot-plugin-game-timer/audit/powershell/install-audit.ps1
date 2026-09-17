[CmdletBinding()]
param(
    [ValidateSet('Install','Remove','Status')][string]$Mode = 'Status',
    [string]$SqlitePath,
    [string]$TargetsPath,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'MashiroBot\usage-audit')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$taskName = 'MashiroBot-UsageAudit'
$project = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\MashiroBot.UsageAudit.csproj'
$sourceHelper = Join-Path $PSScriptRoot 'audit-db-v1.mjs'
$sourceCore = Join-Path (Split-Path -Parent $PSScriptRoot) 'core\audit-storage.mjs'
$publishRoot = Join-Path $InstallRoot 'worker'
$worker = Join-Path $publishRoot 'MashiroBot.UsageAudit.exe'
$helperRoot = Join-Path $InstallRoot 'powershell'
$helper = Join-Path $helperRoot 'audit-db-v1.mjs'
$coreRoot = Join-Path $InstallRoot 'core'
$core = Join-Path $coreRoot 'audit-storage.mjs'
$installedTargets = Join-Path $InstallRoot 'targets.json'
$configPath = Join-Path $InstallRoot 'config.json'

function Get-TaskInfo {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $process = Get-Process -Name 'MashiroBot.UsageAudit' -ErrorAction SilentlyContinue | Select-Object -First 1
    $config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } else { $null }
    $health = $null
    if ($config -and (Test-Path -LiteralPath $helper)) {
        try { $health = (& ([string]$config.NodePath) $helper health ([string]$config.SqlitePath) | ConvertFrom-Json) } catch { $health = [pscustomobject]@{ fresh=$false; error=$_.Exception.Message } }
    }
    return [ordered]@{
        ok = [bool]($task -and $task.Settings.Hidden -and (Test-Path -LiteralPath $worker))
        mode = 'Status'
        task = if ($task) { [ordered]@{ name=$task.TaskName; state=[string]$task.State; hidden=[bool]$task.Settings.Hidden } } else { $null }
        workerExists = Test-Path -LiteralPath $worker
        processId = if ($process) { $process.Id } else { $null }
        health = $health
        installRoot = $InstallRoot
    }
}

function Remove-Audit {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-Process -Name 'MashiroBot.UsageAudit' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    [ordered]@{ ok=$true; mode='Remove'; task=$taskName } | ConvertTo-Json -Depth 6
}

function Install-Audit {
    if (-not $SqlitePath) { throw 'Install requires -SqlitePath.' }
    if (-not $TargetsPath -or -not (Test-Path -LiteralPath $TargetsPath -PathType Leaf)) { throw 'Install requires an existing -TargetsPath.' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node.js not found: $node" }
    New-Item -ItemType Directory -Path $publishRoot,$helperRoot,$coreRoot -Force | Out-Null
    & dotnet publish $project -c Release -r win-x64 --self-contained false -o $publishRoot | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $worker)) { throw 'Publishing audit worker failed.' }
    Copy-Item -LiteralPath $sourceHelper -Destination $helper -Force
    Copy-Item -LiteralPath $sourceCore -Destination $core -Force
    if ([IO.Path]::GetFullPath($TargetsPath) -ne [IO.Path]::GetFullPath($installedTargets)) {
        Copy-Item -LiteralPath $TargetsPath -Destination $installedTargets -Force
    }
    $config = [ordered]@{
        SqlitePath = [IO.Path]::GetFullPath($SqlitePath)
        TargetsPath = $installedTargets
        NodePath = $node
        WorkerPath = $worker
        InstalledAt = (Get-Date).ToString('o')
    }
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8

    $arguments = '--targets "{0}" --database "{1}" --node "{2}" --db-helper "{3}"' -f $installedTargets,$config.SqlitePath,$node,$helper
    $action = New-ScheduledTaskAction -Execute $worker -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
    $status = Get-TaskInfo
    if (-not $status.ok) { throw 'Audit task registration verification failed.' }
    $status.mode = 'Install'
    $status | ConvertTo-Json -Depth 6
}

switch ($Mode) {
    'Install' { Install-Audit }
    'Remove' { Remove-Audit }
    'Status' { (Get-TaskInfo) | ConvertTo-Json -Depth 6 }
}
