param(
    [ValidateRange(1, 180)]
    [int]$Minutes = 30
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

$stateRoot = 'C:\ProgramData\CodexFocusLock'
$expiryPath = Join-Path $stateRoot 'bilibili-qq-expiry.json'
$focusLockScript = Join-Path $stateRoot 'FocusLock.ps1'
$taskName = 'CodexFocusLock-BilibiliTemporaryExpire'
$until = [datetimeoffset]::Now.AddMinutes($Minutes)

if (-not (Test-Path -LiteralPath $expiryPath)) { throw 'The focus lock expiry state was not found.' }
if (-not (Test-Path -LiteralPath $focusLockScript)) { throw 'The installed focus lock script was not found.' }

$state = Get-Content -Raw -LiteralPath $expiryPath -Encoding UTF8 | ConvertFrom-Json
$state | Add-Member -NotePropertyName BilibiliReleaseUntil -NotePropertyValue $until.ToString('o') -Force
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $expiryPath -Encoding UTF8

foreach ($root in @(
    'HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist'
)) {
    if (-not (Test-Path -Path $root)) { continue }
    $properties = Get-ItemProperty -Path $root
    foreach ($property in $properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }) {
        if ([string]$property.Value -match '(?i)(?:bilibili|b23|bilivideo|hdslb)') {
            Remove-ItemProperty -Path $root -Name $property.Name -ErrorAction Stop
        }
    }
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $focusLockScript -Mode Reapply
if ($LASTEXITCODE -ne 0) { throw "FocusLock reapply failed with exit code $LASTEXITCODE" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$focusLockScript`" -Mode Reapply"
$trigger = New-ScheduledTaskTrigger -Once -At $until.LocalDateTime
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null

[pscustomobject]@{
    Status = 'Released'
    Target = 'Bilibili'
    ExpiresAt = $until.ToString('o')
    QQRemainsBlocked = $true
} | ConvertTo-Json
