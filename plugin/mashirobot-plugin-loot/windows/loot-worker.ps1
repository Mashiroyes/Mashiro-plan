[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Evening', 'Morning')][string]$Action,
    [Parameter(Mandatory = $true)][string]$SqlitePath,
    [string]$NodePath = '',
    [string]$Now = '',
    [string]$JobId = '',
    [int]$JobVersion = 1,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$PluginRoot = Split-Path -Parent $PSScriptRoot
$Node = if ($NodePath) { $NodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
$Cli = Join-Path $PluginRoot 'core\worker-cli.mjs'
$MachineModule = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\MashiroBot.MachineConfig.ps1'
$LogPath = Join-Path $env:USERPROFILE '.openclaw\logs\mashirobot.log'
$ControlCli = Join-Path (Split-Path -Parent (Split-Path -Parent $SqlitePath)) 'core\control\reminder-cli.mjs'

function Invoke-ControlReminder([string]$action,[hashtable]$payload){$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Compress -Depth 8)));$raw=& $Node $ControlCli $action $SqlitePath $encoded 2>&1;if($LASTEXITCODE-ne 0){throw($raw-join[Environment]::NewLine)};(($raw-join'')|ConvertFrom-Json)}

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

$managed = $null
try {
    if ($JobId) {
        $jobCli = Join-Path (Split-Path -Parent (Split-Path -Parent $SqlitePath)) 'core\control\job-cli.mjs'
        $claimJson = @{jobId=$JobId;version=$JobVersion} | ConvertTo-Json -Compress
        $claim64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($claimJson))
        $claimRaw = & $Node $jobCli claim $SqlitePath $claim64 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($claimRaw -join [Environment]::NewLine) }
        $jobClaim = ($claimRaw -join '') | ConvertFrom-Json
        if (-not [bool]$jobClaim.claimed) { exit 0 }
    }
    $priority = 2
    $managed = Invoke-ControlReminder 'dispatch' @{sourcePlugin='mashirobot-plugin-loot';kind='habit';priority=$priority;content=[string]$decision.message;requiresAck=$false;repeat=($Action -eq 'Evening');dedupeKey=("loot:"+$Action+":"+$decision.entryDate);sourceRef=[string]$decision.entryDate;dueAt=[DateTimeOffset]::UtcNow.ToString('o')}
    if(-not[bool]$managed.shouldSend){if($JobId){$doneJson=@{jobId=$JobId;version=$JobVersion;ok=$true;recurring=$true}|ConvertTo-Json -Compress;$done64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($doneJson));& $Node $jobCli complete $SqlitePath $done64|Out-Null};Write-LootLog @{ action=$Action;entryDate=$decision.entryDate;result='suppressed';reason=$managed.reason };$managed|ConvertTo-Json -Compress;exit 0}
    if (-not (Test-Path -LiteralPath $MachineModule -PathType Leaf)) { throw "MashiroBot machine configuration helper is missing: $MachineModule" }
    Import-Module $MachineModule -Force
    $delivery = Resolve-MashiroWeixinDelivery
    $sendOutput = & $delivery.OpenClawCommand message send --json --channel 'openclaw-weixin' --account $delivery.Account --target $delivery.Target --message ([string]$managed.message) 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($sendOutput -join [Environment]::NewLine) }
    [void](Invoke-ControlReminder 'finish' @{reminderIds=@($managed.reminderIds);ok=$true})
    if ($JobId) {
        $doneJson = @{jobId=$JobId;version=$JobVersion;ok=$true;recurring=$true} | ConvertTo-Json -Compress
        $done64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($doneJson))
        & $Node $jobCli complete $SqlitePath $done64 | Out-Null
    }
    Write-LootLog @{ action = $Action; entryDate = $decision.entryDate; result = 'sent'; reason = $decision.reason }
    ([ordered]@{ ok = $true; action = 'sent'; entryDate = $decision.entryDate }) | ConvertTo-Json -Compress
} catch {
    if($managed -and $managed.reminderIds){try{[void](Invoke-ControlReminder 'finish' @{reminderIds=@($managed.reminderIds);ok=$false;error=$_.Exception.Message})}catch{}}
    Write-LootLog @{ action = $Action; entryDate = $decision.entryDate; result = 'failed'; error = $_.Exception.Message }
    throw
}
