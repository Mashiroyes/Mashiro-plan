[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PlanRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$RepairScript = Join-Path $PSScriptRoot 'repair-openclaw-adapter.ps1'
$HealthScript = Join-Path $PlanRoot 'core\health\check-mashirobot.ps1'
$GatewayVbs = Join-Path $env:USERPROFILE '.openclaw\gateway.vbs'

if (-not (Test-Path -LiteralPath $RepairScript -PathType Leaf)) {
    throw "MashiroBot adapter repair script is missing: $RepairScript"
}
if (-not (Test-Path -LiteralPath $HealthScript -PathType Leaf)) {
    throw "MashiroBot pre-start health check is missing: $HealthScript"
}
if (-not (Test-Path -LiteralPath $GatewayVbs -PathType Leaf)) {
    throw "OpenClaw gateway entry is missing: $GatewayVbs"
}

& $RepairScript
if ($LASTEXITCODE -ne 0) { throw 'MashiroBot adapter repair failed.' }

& $HealthScript -PreStart
if ($LASTEXITCODE -ne 0) { throw 'MashiroBot pre-start health check failed.' }

Start-Process -FilePath $GatewayVbs -WindowStyle Hidden
