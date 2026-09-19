Set-StrictMode -Version Latest

function Get-FinancialDelivery {
    param([string]$Account, [string]$Target)
    $module = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\MashiroBot.MachineConfig.ps1'
    if (-not (Test-Path -LiteralPath $module -PathType Leaf)) { throw "MashiroBot machine configuration helper is missing: $module" }
    Import-Module $module -Force
    return Resolve-MashiroWeixinDelivery -Account $Account -Target $Target
}

function Write-FinancialReportLog {
    param([Parameter(Mandatory = $true)][string]$Event, [hashtable]$Data = @{})
    $logDir = Join-Path $env:USERPROFILE '.openclaw\logs'
    [IO.Directory]::CreateDirectory($logDir) | Out-Null
    $record = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); event = $Event }
    foreach ($key in $Data.Keys) { $record[$key] = $Data[$key] }
    $line = $record | ConvertTo-Json -Compress -Depth 6
    [IO.File]::AppendAllText((Join-Path $logDir 'mashirobot.log'), $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Invoke-FinancialCli {
    param([string]$NodePath, [string]$CliPath, [string[]]$Arguments)
    $raw = & $NodePath $CliPath @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($raw -join [Environment]::NewLine) }
    return (($raw -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable)
}

function Send-FinancialWeixinMessage {
    param([Parameter(Mandatory = $true)][string]$Message, [switch]$DryRun)
    if ($DryRun) { return @{ ok = $true; dryRun = $true; utf8Length = [Text.Encoding]::UTF8.GetByteCount($Message) } }
    $delivery = Get-FinancialDelivery
    $output = & $delivery.OpenClawCommand message send --json --channel openclaw-weixin `
        --account $delivery.Account --target $delivery.Target --message $Message 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable)
}
