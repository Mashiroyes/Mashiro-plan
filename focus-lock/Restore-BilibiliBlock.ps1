$ErrorActionPreference = 'Stop'

$taskName = 'CodexFocusLock-BilibiliRestore'
$repairTask = 'CodexFocusLock-Repair'
$installedScript = 'C:\ProgramData\CodexFocusLock\FocusLock.ps1'
$resultPath = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\restore-bilibili-result.json'

try {
    if (-not (Test-Path -LiteralPath $installedScript)) {
        throw "Focus lock script not found: $installedScript"
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedScript -Mode Reapply
    Enable-ScheduledTask -TaskName $repairTask -ErrorAction SilentlyContinue | Out-Null

    [pscustomobject]@{
        Status = 'Restored'
        RestoredAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
catch {
    [pscustomobject]@{
        Status = 'Failed'
        FailedAt = (Get-Date).ToString('o')
        Error = $_.Exception.Message
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw
}
finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
