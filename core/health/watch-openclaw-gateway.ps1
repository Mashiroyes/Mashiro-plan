[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [int]$StartupTimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PlanRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$GatewayTaskName = 'OpenClaw Gateway'
$GatewayPort = 18789
$LogDirectory = Join-Path $env:USERPROFILE '.openclaw\logs'
$LogPath = Join-Path $LogDirectory 'gateway-watchdog.log'
$Mutex = [Threading.Mutex]::new($false, 'Local\MashiroBot.OpenClawGatewayWatchdog')
$MutexAcquired = $false

function Write-WatchdogLog {
    param([string]$Message)

    $line = '{0:yyyy-MM-dd HH:mm:ss zzz} {1}' -f (Get-Date), $Message
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
    Write-Output $line
}

function Test-GatewayHealth {
    $OpenClaw = Get-Command openclaw -ErrorAction SilentlyContinue
    if (-not $OpenClaw) { return $false }

    $Output = (& $OpenClaw.Source gateway health --timeout 8000 2>&1 | Out-String).Trim()
    return $LASTEXITCODE -eq 0 -and $Output -match '(?m)^OK\s*\('
}

try {
    $MutexAcquired = $Mutex.WaitOne(0)
    if (-not $MutexAcquired) {
        Write-WatchdogLog 'skip: another gateway watchdog instance is already running'
        exit 0
    }

    if (Test-GatewayHealth) {
        Write-WatchdogLog 'healthy: no restart needed'
        exit 0
    }

    if ($CheckOnly) {
        Write-WatchdogLog 'unhealthy: check-only mode did not restart the gateway'
        exit 1
    }

    $GatewayWrapper = Join-Path $PlanRoot 'core\adapter\start-openclaw-gateway.ps1'
    if (-not (Test-Path -LiteralPath $GatewayWrapper -PathType Leaf)) {
        throw "Gateway startup wrapper is missing: $GatewayWrapper"
    }

    Write-WatchdogLog 'unhealthy: starting the existing OpenClaw Gateway task'
    Start-ScheduledTask -TaskName $GatewayTaskName

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    do {
        Start-Sleep -Seconds 3
        if (Test-GatewayHealth) {
            Write-WatchdogLog 'recovered: gateway health check passed'
            exit 0
        }
    } while ((Get-Date) -lt $deadline)

    throw "Gateway did not become healthy within $StartupTimeoutSeconds seconds. Check $LogPath and the OpenClaw runtime log."
}
catch {
    Write-WatchdogLog "failed: $($_.Exception.Message)"
    exit 1
}
finally {
    if ($Mutex) {
        if ($MutexAcquired) { $Mutex.ReleaseMutex() }
        $Mutex.Dispose()
    }
}
