$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$sourceScript = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\FocusLock.ps1'
$installedScript = 'C:\ProgramData\CodexFocusLock\FocusLock.ps1'
$statePath = 'C:\ProgramData\CodexFocusLock\state.json'
$resultPath = 'C:\ProgramData\CodexFocusLock\hanime-permanent-block-result.json'
$lockName = 'CodexFocusLock'
$taskRepair = "$lockName-Repair"
$taskScan = "$lockName-QQScan"
$taskExpire = "$lockName-Expire"

$result = [ordered]@{
    StartedAt = (Get-Date).ToString('o')
    SourceCopied = $false
    StateUpdated = $false
    Reapplied = $false
    TasksUpdated = $false
    Error = $null
}

try {
    if (-not (Test-Path -LiteralPath $sourceScript)) {
        throw "Source script not found: $sourceScript"
    }
    if (-not (Test-Path -LiteralPath $statePath)) {
        throw "Focus lock state not found: $statePath"
    }

    Copy-Item -LiteralPath $sourceScript -Destination $installedScript -Force
    $result.SourceCopied = $true

    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $state | Add-Member -NotePropertyName Permanent -NotePropertyValue $true -Force
    $state.ExpiresAt = '2099-12-31T23:59:59+08:00'
    $state.DurationDays = 'Permanent'
    $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statePath -Encoding UTF8
    $result.StateUpdated = $true

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedScript -Mode Reapply | Out-Null
    $result.Reapplied = $true

    $repairCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$installedScript`" -Mode Reapply"
    $scanCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$installedScript`" -Mode Scan"
    & schtasks.exe /Create /TN $taskRepair /SC MINUTE /MO 5 /RU SYSTEM /RL HIGHEST /TR $repairCommand /F | Out-Null
    & schtasks.exe /Create /TN $taskScan /SC MINUTE /MO 1 /RU SYSTEM /RL HIGHEST /TR $scanCommand /F | Out-Null
    & schtasks.exe /Delete /TN $taskExpire /F 2>$null | Out-Null
    $result.TasksUpdated = $true
} catch {
    $result.Error = $_.Exception.Message
    throw
} finally {
    $result.FinishedAt = (Get-Date).ToString('o')
    New-Item -ItemType Directory -Path (Split-Path -Parent $resultPath) -Force | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
