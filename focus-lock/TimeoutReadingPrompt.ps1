[CmdletBinding()]
param(
    [ValidateSet('Open','Submit','InstallTask')]
    [string]$Mode = 'Open',
    [string]$EventKey,
    [string]$PdfPath = 'C:\Users\Mashiroyes\Desktop\语言引论 (弗罗姆金) (z-library.sk, 1lib.sk, z-lib.sk).pdf',
    [string]$StateRoot = (Join-Path $env:ProgramData 'CodexFocusLock'),
    [string]$TaskName = 'CodexFocusLock-TimeoutReadingPrompt',
    [string]$UserName,
    [switch]$FixtureMode
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ledgerPath = Join-Path $StateRoot 'timeout-reading-events.json'
$installedScript = Join-Path $StateRoot 'TimeoutReadingPrompt.ps1'

function Save-Atomic([string]$Path, $Value) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Install-InteractiveTask {
    if (-not $UserName) { throw 'UserName is required to install the timeout reading task.' }
    if ($UserName -notmatch '\\') { $UserName = "$env:COMPUTERNAME\\$UserName" }
    if ($PSCommandPath -ne $installedScript) {
        New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
        Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force
    }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$installedScript`" -Mode Open -PdfPath `"$PdfPath`" -StateRoot `"$StateRoot`""
    $principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances Parallel -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ([string]$task.Actions[0].Arguments -notmatch [regex]::Escape($installedScript)) { throw 'Timeout reading task action verification failed.' }
    [ordered]@{ ok=$true; mode='InstallTask'; taskName=$TaskName; script=$installedScript; pdfPath=$PdfPath } | ConvertTo-Json -Compress
}

function Open-Pdf {
    if (-not (Test-Path -LiteralPath $PdfPath -PathType Leaf)) { throw "Configured reading PDF is missing: $PdfPath" }
    if (-not $FixtureMode) { Start-Process -FilePath $PdfPath | Out-Null }
    [ordered]@{ ok=$true; mode='Open'; pdfPath=$PdfPath; opened=(-not $FixtureMode) } | ConvertTo-Json -Compress
}

function Submit-Event {
    if ([string]::IsNullOrWhiteSpace($EventKey)) { throw 'EventKey is required for Submit.' }
    $mutex = [Threading.Mutex]::new($false, 'Global\CodexFocusLock.TimeoutReadingPrompt')
    $held = $false
    try {
        $held = $mutex.WaitOne([TimeSpan]::FromSeconds(15))
        if (-not $held) { throw 'Timed out waiting for the timeout-reading ledger.' }
        $ledger = [ordered]@{ events = @() }
        if (Test-Path -LiteralPath $ledgerPath) {
            try { $ledger = Get-Content -LiteralPath $ledgerPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $ledger = [ordered]@{ events = @() } }
        }
        $events = @($ledger.events)
        if (@($events | Where-Object { [string]$_.key -eq $EventKey }).Count -gt 0) {
            [ordered]@{ ok=$true; mode='Submit'; eventKey=$EventKey; opened=$false; duplicate=$true } | ConvertTo-Json -Compress
            return
        }
        $ledger = [ordered]@{ events = @($events + [pscustomobject]@{ key=$EventKey; submittedAt=[DateTimeOffset]::UtcNow.ToString('o') }) }
        Save-Atomic $ledgerPath $ledger
        if (-not $FixtureMode) { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
        [ordered]@{ ok=$true; mode='Submit'; eventKey=$EventKey; opened=$true; duplicate=$false } | ConvertTo-Json -Compress
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

switch ($Mode) {
    'Open' { Open-Pdf }
    'Submit' { Submit-Event }
    'InstallTask' { Install-InteractiveTask }
}

