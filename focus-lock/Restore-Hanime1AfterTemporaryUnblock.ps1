$ErrorActionPreference = 'Stop'

$taskName = 'CodexFocusLock-HanimeRestore'
$repairTask = 'CodexFocusLock-Repair'
$root = Split-Path -Parent $PSCommandPath
$reblock = Join-Path $root 'Reblock-Hanime1.ps1'
$resultPath = Join-Path $root 'temporary-unblock-hanime1-restore-result.json'
$succeeded = $false

try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reblock
    if ($LASTEXITCODE -ne 0) { throw "Hanime restore failed with exit code $LASTEXITCODE" }
    Enable-ScheduledTask -TaskName $repairTask -ErrorAction SilentlyContinue | Out-Null
    [pscustomobject]@{
        Status = 'Restored'
        RestoredAt = (Get-Date).ToString('o')
        NotificationSent = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    $succeeded = $true
}
catch {
    [pscustomobject]@{
        Status = 'Failed'
        FailedAt = (Get-Date).ToString('o')
        Error = $_.Exception.Message
        NotificationSent = $false
    } | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw
}
finally {
    if ($succeeded) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}
