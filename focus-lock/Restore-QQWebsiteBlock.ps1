[CmdletBinding()]
param(
    [string]$ResultPath = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\restore-qq-website-result.json'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskName = 'CodexFocusLock-QQWebsiteRestore'
$repairTask = 'CodexFocusLock-Repair'
$installedScript = 'C:\ProgramData\CodexFocusLock\FocusLock.ps1'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$qqDomainPattern = '(?i)(?:^|\.)(?:im\.qq\.com|pc\.qq\.com|dldir\.qq\.com|dldir1\.qq\.com|dldir1v6\.qq\.com|download\.imqq\.com)$'

try {
    if (-not (Test-Path -LiteralPath $installedScript)) { throw "FocusLock script not found: $installedScript" }
    & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $installedScript -Mode Reapply | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'FocusLock reapply failed.' }
    Enable-ScheduledTask -TaskName $repairTask -ErrorAction SilentlyContinue | Out-Null
    & ipconfig.exe /flushdns | Out-Null

    $hostsCount = 0
    if (Test-Path -LiteralPath $hostsPath) {
        foreach ($line in ([IO.File]::ReadAllText($hostsPath) -split '\r?\n')) {
            $parts = $line.Trim() -split '\s+'
            if ($parts.Count -ge 2 -and $parts[1] -match $qqDomainPattern) { $hostsCount++ }
        }
    }
    if ($hostsCount -lt 1) { throw 'QQ website hosts rules were not restored.' }
    [ordered]@{ Status='Restored'; RestoredAt=(Get-Date).ToString('o'); HostsEntries=$hostsCount } |
        ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}
catch {
    [ordered]@{ Status='Failed'; FailedAt=(Get-Date).ToString('o'); Error=$_.Exception.Message } |
        ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
    throw
}
finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
