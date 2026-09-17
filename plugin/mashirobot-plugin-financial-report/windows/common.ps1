Set-StrictMode -Version Latest

$script:OpenClawCmd = 'D:\Program\nodejs\npm_global24\openclaw.cmd'
$script:OpenClawPs1 = 'D:\Program\nodejs\npm_global24\openclaw.ps1'
$script:WeixinAccount = 'ea8fd13b2100-im-bot'
$script:WeixinTarget = 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat'

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
    if (-not (Test-Path -LiteralPath $script:OpenClawPs1)) { throw "OpenClaw PowerShell entry not found: $script:OpenClawPs1" }
    $output = & $script:OpenClawPs1 message send --json --channel openclaw-weixin `
        --account $script:WeixinAccount --target $script:WeixinTarget --message $Message 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable)
}
