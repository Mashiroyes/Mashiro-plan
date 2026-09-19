[CmdletBinding()]
param(
    [string]$OpenClawCommand,
    [string]$WeixinAccount,
    [Parameter(Mandatory = $true)][string]$WeixinTarget,
    [string]$CloudMusicPath,
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'MashiroBot\config\machine.json')
)

$ErrorActionPreference = 'Stop'
$moduleSource = Join-Path $PSScriptRoot 'MashiroBot.MachineConfig.ps1'
$configDir = Split-Path -Parent ([IO.Path]::GetFullPath($ConfigPath))
[IO.Directory]::CreateDirectory($configDir) | Out-Null
$moduleTarget = Join-Path $configDir 'MashiroBot.MachineConfig.ps1'
Copy-Item -LiteralPath $moduleSource -Destination $moduleTarget -Force
Import-Module $moduleTarget -Force
$existing = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { Read-MashiroMachineConfig -Path $ConfigPath } else { $null }
if (-not $OpenClawCommand -and $existing) { $OpenClawCommand = [string]$existing.openClawCommand }
if (-not $WeixinAccount -and $existing) { $WeixinAccount = [string]$existing.weixinAccount }
if (-not $CloudMusicPath -and $existing) { $CloudMusicPath = [string]$existing.cloudMusicPath }

$probe = [pscustomobject]@{ openClawCommand=$OpenClawCommand; weixinAccount=$WeixinAccount; weixinTarget=$WeixinTarget; cloudMusicPath=$CloudMusicPath }
if (-not $OpenClawCommand) { $OpenClawCommand = Resolve-MashiroOpenClawCommand -Config $probe }
if (-not $WeixinAccount) {
    $delivery = Resolve-MashiroWeixinDelivery -Config $probe -Target $WeixinTarget
    $WeixinAccount = $delivery.Account
}
if ($CloudMusicPath -and -not (Test-Path -LiteralPath $CloudMusicPath -PathType Leaf)) { throw "CloudMusic executable does not exist: $CloudMusicPath" }

$value = [ordered]@{
    schemaVersion = 1
    openClawCommand = [IO.Path]::GetFullPath($OpenClawCommand)
    weixinAccount = $WeixinAccount
    weixinTarget = $WeixinTarget
    cloudMusicPath = if ($CloudMusicPath) { [IO.Path]::GetFullPath($CloudMusicPath) } else { '' }
    gameExecutableOverrides = if ($existing -and $existing.gameExecutableOverrides) { $existing.gameExecutableOverrides } else { [ordered]@{} }
}
$temp = Join-Path $configDir ('.machine-' + [guid]::NewGuid().ToString('N') + '.tmp')
$value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding UTF8
Move-Item -LiteralPath $temp -Destination $ConfigPath -Force
[ordered]@{ ok=$true; configPath=[IO.Path]::GetFullPath($ConfigPath); modulePath=$moduleTarget; weixinAccount=$WeixinAccount; weixinTargetConfigured=$true } | ConvertTo-Json -Depth 4
