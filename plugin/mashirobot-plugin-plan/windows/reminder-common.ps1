Set-StrictMode -Version Latest

$script:PlannerPython = (Get-Command python.exe -ErrorAction Stop).Source
$script:PlannerCli = Join-Path (Split-Path -Parent $PSScriptRoot) 'planner\planner.py'
$script:PluginId = 'mashirobot-plugin-plan'
function Get-MashiroDeliveryConfig {
    $module = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\MashiroBot.MachineConfig.ps1'
    if (-not (Test-Path -LiteralPath $module -PathType Leaf)) { throw "MashiroBot machine configuration helper is missing: $module" }
    Import-Module $module -Force
    return Resolve-MashiroWeixinDelivery
}

function Get-ShanghaiNow {
    return [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(
        [DateTimeOffset]::UtcNow,
        'China Standard Time'
    )
}

function Write-ReminderLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $logDir = Join-Path $env:USERPROFILE '.openclaw\logs'
    [IO.Directory]::CreateDirectory($logDir) | Out-Null
    $logPath = Join-Path $logDir 'mashirobot.log'
    $line = '{0} [{1}] {2}' -f (Get-ShanghaiNow).ToString('yyyy-MM-dd HH:mm:ss zzz'), $script:PluginId, $Message
    [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Invoke-PlannerJson {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    return Invoke-PlannerDb -Arguments $Arguments
}

function Get-PlanPluginState {
    param([Parameter(Mandatory = $true)][string]$StateKey)

    $result = Invoke-PlannerJson -Arguments @(
        'get-plugin-state', '--plugin-id', $script:PluginId, '--state-key', $StateKey
    )
    if (-not [bool]$result.found) { return $null }
    return $result.value
}

function Set-PlanPluginState {
    param(
        [Parameter(Mandatory = $true)][string]$StateKey,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$State
    )

    $json = $State | ConvertTo-Json -Compress -Depth 8
    $payload64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    Invoke-PlannerJson -Arguments @(
        'set-plugin-state', '--plugin-id', $script:PluginId,
        '--state-key', $StateKey, '--payload-base64', $payload64
    ) | Out-Null
}

function Remove-PlanPluginState {
    param([Parameter(Mandatory = $true)][string]$StateKey)

    Invoke-PlannerJson -Arguments @(
        'delete-plugin-state', '--plugin-id', $script:PluginId, '--state-key', $StateKey
    ) | Out-Null
}

function Invoke-PlannerDb {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    if (-not (Test-Path -LiteralPath $script:PlannerPython)) {
        throw "Python executable not found: $script:PlannerPython"
    }
    if (-not (Test-Path -LiteralPath $script:PlannerCli)) {
        throw "Planner database script not found: $script:PlannerCli"
    }
    $output = & $script:PlannerPython $script:PlannerCli @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ($output -join [Environment]::NewLine)
    }
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable)
}

function Send-OpenClawWeixinMessage {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$DryRun
    )

    $delivery = Get-MashiroDeliveryConfig

    $attempts = if ($DryRun) { 1 } else { 4 }
    $lastError = $null
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        try {
            $arguments = @(
                'message', 'send', '--json',
                '--channel', 'openclaw-weixin',
                '--account', $delivery.Account,
                '--target', $delivery.Target,
                '--message', $Message
            )
            if ($DryRun) { $arguments += '--dry-run' }
            $sendOutput = & $delivery.OpenClawCommand @arguments 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw ($sendOutput -join [Environment]::NewLine)
            }
            return ($sendOutput -join [Environment]::NewLine)
        } catch {
            $lastError = $_.Exception
            Write-ReminderLog ('Weixin send attempt {0}/{1} failed: {2}' -f $attempt, $attempts, $lastError.Message)
            if ($attempt -lt $attempts) { Start-Sleep -Seconds 5 }
        }
    }
    throw $lastError
}

function Remove-OpenClawPlanTask {
    param([string]$TaskName)

    if (-not $TaskName -or -not $TaskName.StartsWith('OpenClaw-Plan-')) { return }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
