[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$planRoot = Split-Path -Parent $PSScriptRoot
$sourceFocus = Join-Path $PSScriptRoot 'FocusLock.ps1'
$runtimeFocusRoot = Join-Path $env:ProgramData 'CodexFocusLock'
$runtimeFocus = Join-Path $runtimeFocusRoot 'FocusLock.ps1'
$installer = Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\qq\powershell\install-qq-session.ps1'
$database = Join-Path $planRoot 'sqlite\openclaw-planner.sqlite'
$qqStateRoot = Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq'
$backupRoot = Join-Path $env:ProgramData ('MashiroBot\repair-backups\plan-qq-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$resultPath = Join-Path $env:ProgramData 'MashiroBot\plan-qq-repair-result.json'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This repair must run as Administrator.'
    }
}

function Get-TaskEvidence([string]$Name) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task) { return [ordered]@{ name=$Name; exists=$false } }
    $info = Get-ScheduledTaskInfo -TaskName $Name
    return [ordered]@{
        name = $Name
        exists = $true
        state = [string]$task.State
        principal = [string]$task.Principal.UserId
        runLevel = [string]$task.Principal.RunLevel
        lastResult = [int]$info.LastTaskResult
        lastRun = $info.LastRunTime.ToString('o')
        nextRun = if ($info.NextRunTime -gt [datetime]::MinValue) { $info.NextRunTime.ToString('o') } else { $null }
    }
}

Assert-Administrator
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

foreach ($path in @(
    $runtimeFocus,
    (Join-Path $runtimeFocusRoot 'state.json'),
    (Join-Path $qqStateRoot 'last-status.json'),
    $database,
    ($database + '-wal'),
    ($database + '-shm')
)) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Copy-Item -LiteralPath $path -Destination (Join-Path $backupRoot ([IO.Path]::GetFileName($path))) -Force
    }
}

foreach ($taskName in @('CodexFocusLock-Repair','CodexFocusLock-QQScan','MashiroBot-QQSession-Reconcile')) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) { Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $backupRoot ($taskName + '.xml')) -Encoding UTF8 }
}

Stop-ScheduledTask -TaskName 'MashiroBot-QQSession-Reconcile' -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $sourceFocus -Destination $runtimeFocus -Force
& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runtimeFocus -Mode Reapply | Out-Null
if ($LASTEXITCODE -ne 0) { throw "FocusLock Reapply failed with exit code $LASTEXITCODE." }

& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installer -Mode Install -SqlitePath $database | Out-Null
if ($LASTEXITCODE -ne 0) { throw "QQ session installation failed with exit code $LASTEXITCODE." }

$deadline = (Get-Date).AddSeconds(120)
do {
    Start-Sleep -Milliseconds 500
    $status = if (Test-Path -LiteralPath (Join-Path $qqStateRoot 'last-status.json')) {
        Get-Content -LiteralPath (Join-Path $qqStateRoot 'last-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
    } else { $null }
    $healthy = $status -and $status.ok -and $status.clientBarrierActive -and $status.websiteBlockActive -and $status.vaultReady -and -not $status.qqInstalled
} while (-not $healthy -and (Get-Date) -lt $deadline)

$stateFile = Get-Item -LiteralPath (Join-Path $runtimeFocusRoot 'state.json')
$result = [ordered]@{
    ok = [bool]$healthy
    repairedAt = (Get-Date).ToString('o')
    backup = $backupRoot
    focusLockHashMatches = ((Get-FileHash -LiteralPath $sourceFocus -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $runtimeFocus -Algorithm SHA256).Hash)
    stateFileBytes = [int64]$stateFile.Length
    status = $status
    tasks = @(
        Get-TaskEvidence 'CodexFocusLock-Repair'
        Get-TaskEvidence 'CodexFocusLock-QQScan'
        Get-TaskEvidence 'MashiroBot-QQSession-Reconcile'
    )
}
$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding UTF8
if (-not $healthy) { throw "QQ protection verification failed. See $resultPath" }
$result | ConvertTo-Json -Depth 12
