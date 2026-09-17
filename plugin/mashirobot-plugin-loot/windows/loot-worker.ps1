[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Evening', 'Morning')][string]$Action,
    [Parameter(Mandatory = $true)][string]$SqlitePath,
    [string]$NodePath = '',
    [string]$Now = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$PluginRoot = Split-Path -Parent $PSScriptRoot
$Node = if ($NodePath) { $NodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
$Cli = Join-Path $PluginRoot 'core\worker-cli.mjs'
$OpenClaw = 'D:\Program\nodejs\npm_global24\openclaw.ps1'
$Account = 'ea8fd13b2100-im-bot'
$Target = 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat'
$LogPath = Join-Path $env:USERPROFILE '.openclaw\logs\mashirobot.log'

function Write-LootLog {
    param([hashtable]$Fields)
    $directory = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $record = [ordered]@{ timestamp = [DateTimeOffset]::Now.ToString('o'); pluginId = 'mashirobot-plugin-loot' } + $Fields
    Add-Content -LiteralPath $LogPath -Value (($record | ConvertTo-Json -Compress)) -Encoding utf8
}

$cliArgs = @($Cli, '--sqlite', $SqlitePath, '--action', $Action.ToLowerInvariant())
if ($Now) { $cliArgs += @('--now', $Now) }
$raw = & $Node @cliArgs 2>&1
if ($LASTEXITCODE -ne 0) { throw ($raw -join [Environment]::NewLine) }
$decision = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
if ($decision.action -eq 'skip') {
    Write-LootLog @{ action = $Action; entryDate = $decision.entryDate; result = 'skip'; reason = $decision.reason }
    $decision | ConvertTo-Json -Compress
    exit 0
}

if ($DryRun) {
    Write-LootLog @{ action = $Action; entryDate = $decision.entryDate; result = 'dry-run'; reason = $decision.reason }
    ([ordered]@{ ok = $true; action = 'dry-run'; decision = $decision }) | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

try {
    $sendOutput = & $OpenClaw message send --json --channel 'openclaw-weixin' --account $Account --target $Target --message ([string]$decision.message) 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($sendOutput -join [Environment]::NewLine) }
    Write-LootLog @{ action = $Action; entryDate = $decision.entryDate; result = 'sent'; reason = $decision.reason }
    ([ordered]@{ ok = $true; action = 'sent'; entryDate = $decision.entryDate }) | ConvertTo-Json -Compress
} catch {
    Write-LootLog @{ action = $Action; entryDate = $decision.entryDate; result = 'failed'; error = $_.Exception.Message }
    throw
}
