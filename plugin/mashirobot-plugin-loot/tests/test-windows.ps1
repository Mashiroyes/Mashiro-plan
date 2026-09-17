[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Join-Path $env:TEMP ('MashiroBot-loot-test-' + [guid]::NewGuid().ToString('N'))
$db = Join-Path $root 'planner.sqlite'
$worker = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\loot-worker.ps1'
New-Item -ItemType Directory -Path $root -Force | Out-Null
try {
    $output = & pwsh.exe -NoProfile -File $worker -Action Evening -SqlitePath $db -Now '2026-08-18T21:00:00+08:00' -DryRun
    if ($LASTEXITCODE -ne 0) { throw 'Evening DryRun exited with a non-zero code.' }
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($result.action -ne 'dry-run' -or $result.decision.action -ne 'send') { throw 'Evening DryRun did not produce a send decision.' }

    $second = & pwsh.exe -NoProfile -File $worker -Action Evening -SqlitePath $db -Now '2026-08-18T22:01:00+08:00' -DryRun
    if ($LASTEXITCODE -ne 0) { throw 'Outside-window DryRun exited with a non-zero code.' }
    $secondResult = ($second -join [Environment]::NewLine) | ConvertFrom-Json
    if ($secondResult.action -ne 'skip' -or $secondResult.reason -ne 'outside-evening-window') { throw 'Outside-window decision is incorrect.' }
    Write-Output 'test-windows.ps1: PASS'
} finally {
    if (Test-Path -LiteralPath $root) {
        try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { Write-Warning "Temporary test cleanup failed: $($_.Exception.Message)" }
    }
}
