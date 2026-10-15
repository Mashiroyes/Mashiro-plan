$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "ASSERTION FAILED: $Message" }
}

$PlanRoot = Split-Path -Parent $PSScriptRoot
$TempRoot = Join-Path $env:TEMP ('MashiroJobReconcileTest-' + [guid]::NewGuid().ToString('N'))
$SqlitePath = Join-Path $TempRoot 'planner.sqlite'
$Cli = Join-Path $PlanRoot 'core\control\job-cli.mjs'
$Reconcile = Join-Path $PlanRoot 'core\control\windows\job-reconcile.ps1'
$global:MashiroJobReconcileRegistered = @()

function Get-ScheduledTask { @() }
function Unregister-ScheduledTask { param([string]$TaskName, [switch]$Confirm, $ErrorAction) }
function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument) [pscustomobject]@{ Execute=$Execute; Arguments=$Argument } }
function New-ScheduledTaskTrigger { param([switch]$Once, [datetime]$At, [timespan]$RepetitionInterval) [pscustomobject]@{ At=$At } }
function New-ScheduledTaskSettingsSet { [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { param([string]$UserId, $LogonType, $RunLevel) [pscustomobject]@{ UserId=$UserId } }
function New-ScheduledTask { param($Action, $Trigger, $Settings, $Principal) [pscustomobject]@{ Actions=@($Action) } }
function Register-ScheduledTask {
    param([string]$TaskName, $InputObject, [switch]$Force)
    $global:MashiroJobReconcileRegistered += $TaskName
    [pscustomobject]@{ TaskName=$TaskName }
}

try {
    New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
    $payload = @{
        jobId='fixture:future'
        version=1
        owner='fixture'
        kind='one-shot'
        taskName='OpenClaw-Fixture-Future'
        runAt=(Get-Date).AddHours(1).ToUniversalTime().ToString('o')
        payload=@{ execution=@{ executable='C:\Windows\System32\cmd.exe'; arguments='/c exit 0' } }
    } | ConvertTo-Json -Depth 8 -Compress
    $payload64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    & node $Cli upsert $SqlitePath $payload64 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Fixture upsert failed with exit code $LASTEXITCODE" }

    $raw = @(& $Reconcile -Mode Apply -SqlitePath $SqlitePath 2>&1)
    $report = ($raw[-1] | ConvertFrom-Json)
    if (-not $report.ok) { Write-Output ($report | ConvertTo-Json -Depth 8) }
    Assert-True $report.ok 'legacy execution-only payload must reconcile successfully'
    Assert-True ($report.failed.Count -eq 0) 'legacy payload must not produce a failed repair'
    Assert-True ($global:MashiroJobReconcileRegistered -contains 'OpenClaw-Fixture-Future') 'future task must use the generic registration path'
    Assert-True ($report.expiredPastOneShot -eq 0) 'future one-shot task must not expire'
    Write-Output 'PASS: legacy job reconciliation and stale one-shot preflight'
}
finally {
    Remove-Variable -Name MashiroJobReconcileRegistered -Scope Global -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
