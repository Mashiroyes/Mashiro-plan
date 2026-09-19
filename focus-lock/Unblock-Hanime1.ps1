$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

$domainPattern = '(?i)^(?:www\.)?hanime1\.me$'
$browserPatterns = @('*://hanime1.me/*', '*://*.hanime1.me/*')
$clashRule = 'DOMAIN-SUFFIX,hanime1.me,REJECT'
$stateRoot = Join-Path $env:ProgramData 'CodexFocusLock'
$statePath = Join-Path $stateRoot 'state.json'
$installedScript = Join-Path $stateRoot 'FocusLock.ps1'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$clashRoot = Join-Path 'C:\Users\Mashiroyes\AppData\Roaming' 'io.github.clash-verge-rev.clash-verge-rev'
$backupRoot = Join-Path 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\backups' (Get-Date -Format 'yyyyMMdd-HHmmss')
$resultPath = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\unblock-hanime1-result.json'
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

$changed = [System.Collections.Generic.List[string]]::new()

function Backup-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $safeName = ($Path -replace '^[A-Za-z]:', '') -replace '[\\/:*?"<>|]', '_'
    Copy-Item -LiteralPath $Path -Destination (Join-Path $backupRoot $safeName) -Force
}

function Remove-HanimeFromFocusScript([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $raw = [IO.File]::ReadAllText($Path)
    $updated = [regex]::Replace($raw, "(?m)^\s*'(?:www\.)?hanime1\.me',\r?\n", '')
    $updated = [regex]::Replace($updated, "(?m)^\s*'\*://(?:\*\.)?hanime1\.me/\*',\r?\n", '')
    $updated = [regex]::Replace($updated, "(?m)^\s*'DOMAIN-SUFFIX,hanime1\.me,REJECT',\r?\n", '')
    if ($updated -ne $raw) {
        Backup-File $Path
        [IO.File]::WriteAllText($Path, $updated, [Text.UTF8Encoding]::new($false))
        $changed.Add($Path)
    }
}

Remove-HanimeFromFocusScript $installedScript

if (Test-Path -LiteralPath $hostsPath) {
    $raw = [IO.File]::ReadAllText($hostsPath)
    $lines = $raw -split '\r?\n'
    $kept = foreach ($line in $lines) {
        $trimmed = $line.Trim()
        $parts = $trimmed -split '\s+'
        if ($parts.Count -ge 2 -and $parts[1] -match $domainPattern) { continue }
        $line
    }
    $updated = ($kept -join "`r`n").TrimEnd() + "`r`n"
    if ($updated -ne $raw) {
        Backup-File $hostsPath
        [IO.File]::WriteAllText($hostsPath, $updated, [Text.UTF8Encoding]::new($false))
        $changed.Add($hostsPath)
    }
}

$policyRoots = @(
    'HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist'
)
foreach ($root in $policyRoots) {
    if (-not (Test-Path -Path $root)) { continue }
    $properties = Get-ItemProperty -Path $root
    foreach ($property in $properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }) {
        if ($browserPatterns -contains [string]$property.Value) {
            Remove-ItemProperty -Path $root -Name $property.Name
            $changed.Add("$root::$($property.Name)")
        }
    }
}

if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json
    $before = @($state.PolicyEntries).Count
    $state.PolicyEntries = @($state.PolicyEntries | Where-Object { $browserPatterns -notcontains [string]$_.Value })
    if (@($state.PolicyEntries).Count -ne $before) {
        Backup-File $statePath
        $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
        $changed.Add($statePath)
    }
}

$clashPaths = @()
if (Test-Path -LiteralPath $clashRoot) {
    $clashPaths += Get-ChildItem -LiteralPath $clashRoot -File -Filter 'clash-verge*.yaml' -ErrorAction SilentlyContinue
    $profileRoot = Join-Path $clashRoot 'profiles'
    if (Test-Path -LiteralPath $profileRoot) {
        $clashPaths += Get-ChildItem -LiteralPath $profileRoot -File -Filter '*.yaml' -ErrorAction SilentlyContinue
    }
}
foreach ($file in $clashPaths | Select-Object -Unique) {
    $raw = [IO.File]::ReadAllText($file.FullName)
    $updated = [regex]::Replace($raw, "(?m)^\s*-\s*$([regex]::Escape($clashRule))\s*\r?\n", '')
    if ($updated -ne $raw) {
        Backup-File $file.FullName
        [IO.File]::WriteAllText($file.FullName, $updated, [Text.UTF8Encoding]::new($false))
        $changed.Add($file.FullName)
    }
}

& ipconfig.exe /flushdns | Out-Null
Get-Process -Name 'verge-mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
    CompletedAt = (Get-Date).ToString('o')
    Changed = @($changed)
    BackupRoot = $backupRoot
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
