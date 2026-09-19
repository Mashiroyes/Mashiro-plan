[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Configure','Install','Inspect')][string]$Action,
    [string]$SqlitePath,
    [string]$OpenClawCommand,
    [string]$WeixinAccount,
    [string]$WeixinTarget,
    [string]$CloudMusicPath,
    [switch]$IncludeFinancialReport
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$planRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $SqlitePath) { $SqlitePath = Join-Path $planRoot 'sqlite\openclaw-planner.sqlite' }
$SqlitePath = [IO.Path]::GetFullPath($SqlitePath)
$configPath = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\machine.json'

if ($Action -eq 'Inspect') {
    $health = & pwsh -NoProfile -File (Join-Path $planRoot 'core\health\check-mashirobot.ps1') 2>&1
    $health
    exit $LASTEXITCODE
}
if (-not $WeixinTarget) { throw 'Configure and Install require -WeixinTarget.' }

$initArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'initialize-machine-config.ps1'),'-WeixinTarget',$WeixinTarget)
if ($OpenClawCommand) { $initArgs += @('-OpenClawCommand',$OpenClawCommand) }
if ($WeixinAccount) { $initArgs += @('-WeixinAccount',$WeixinAccount) }
if ($CloudMusicPath) { $initArgs += @('-CloudMusicPath',$CloudMusicPath) }
& pwsh @initArgs
if ($LASTEXITCODE -ne 0) { throw 'Machine configuration initialization failed.' }
if ($Action -eq 'Configure') { exit 0 }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Install must run from an elevated PowerShell 7 window.'
}
if (-not (Test-Path -LiteralPath $SqlitePath -PathType Leaf)) { throw "Planner database is missing: $SqlitePath" }

& pwsh -NoProfile -File (Join-Path $planRoot 'core\adapter\repair-openclaw-adapter.ps1') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'OpenClaw adapter repair failed.' }
& pwsh -NoProfile -File (Join-Path $planRoot 'core\health\install-openclaw-gateway-watchdog.ps1') | Out-Host
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $planRoot 'focus-lock\FocusLock.ps1') -Mode Install | Out-Host
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\block\powershell\install-block.ps1') -Mode Install -SqlitePath $SqlitePath | Out-Host
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\game-locker\powershell\install-game-locker.ps1') -Mode Install -SqlitePath $SqlitePath | Out-Host
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\qq\powershell\install-qq-session.ps1') -Mode Install -SqlitePath $SqlitePath | Out-Host
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $planRoot 'plugin\mashirobot-plugin-loot\windows\install.ps1') -Action Install -SqlitePath $SqlitePath | Out-Host
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $planRoot 'plugin\mashirobot-plugin-plan\windows\install-english-skills.ps1') -Action Install -SqlitePath $SqlitePath | Out-Host
if ($IncludeFinancialReport) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $planRoot 'plugin\mashirobot-plugin-financial-report\windows\install-financial-report.ps1') -Action Install -SqlitePath $SqlitePath | Out-Host
}
& pwsh -NoProfile -File (Join-Path $planRoot 'core\adapter\start-openclaw-gateway.ps1') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Gateway startup failed.' }
& pwsh -NoProfile -File (Join-Path $planRoot 'core\health\check-mashirobot.ps1') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Final health check failed.' }

[ordered]@{ ok=$true; action='Install'; planRoot=$planRoot; sqlitePath=$SqlitePath; machineConfigPath=$configPath; temperatureMonitorInstalled=$false } | ConvertTo-Json -Depth 4
