param(
    [Parameter(Mandatory = $true)]
    [string]$StatePath
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not (Test-Path -LiteralPath $StatePath)) {
    exit 0
}

$state = Get-Content -Raw -LiteralPath $StatePath -Encoding UTF8 | ConvertFrom-Json
$processes = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq $state.ProcessName }

if ($state.ExecutablePath) {
    $processes = $processes | Where-Object {
        -not $_.ExecutablePath -or
        [string]::Equals(
            $_.ExecutablePath,
            [string]$state.ExecutablePath,
            [StringComparison]::OrdinalIgnoreCase
        )
    }
}

$closedIds = @()
foreach ($process in @($processes)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    $closedIds += $process.ProcessId
}

$stateRoot = Split-Path -Parent $StatePath
$logRoot = Join-Path (Split-Path -Parent $stateRoot) 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$log = [pscustomobject]@{
    TimerId = $state.TimerId
    DisplayName = $state.DisplayName
    CheckedAt = (Get-Date).ToString('o')
    ClosedProcessIds = @($closedIds)
}
$log | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $logRoot ($state.TimerId + '.json')) -Encoding UTF8

Unregister-ScheduledTask -TaskName $state.TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
