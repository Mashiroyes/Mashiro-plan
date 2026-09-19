$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

$sourceScript = Join-Path $PSScriptRoot 'FocusLock.ps1'
$stateRoot = Join-Path $env:ProgramData 'CodexFocusLock'
$installedScript = Join-Path $stateRoot 'FocusLock.ps1'
$statePath = Join-Path $stateRoot 'state.json'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$hostsEnd = '# END CODEX FOCUS LOCK'
$browserPatterns = @('*://hanime1.me/*', '*://*.hanime1.me/*')
$clashRule = 'DOMAIN-SUFFIX,hanime1.me,REJECT'
$clashRoot = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
$resultPath = Join-Path $PSScriptRoot 'reblock-hanime1-result.json'
$changed = [System.Collections.Generic.List[string]]::new()

Copy-Item -LiteralPath $sourceScript -Destination $installedScript -Force
$changed.Add($installedScript)

$hostsRaw = [IO.File]::ReadAllText($hostsPath)
$hostsUpdated = $hostsRaw
$hostEntries = @("0.0.0.0`thanime1.me", "0.0.0.0`twww.hanime1.me")
foreach ($entry in $hostEntries) {
    if ($hostsUpdated -notmatch "(?m)^\s*0\.0\.0\.0\s+$([regex]::Escape(($entry -split '\s+')[1]))\s*$") {
        $hostsUpdated = $hostsUpdated.Replace($hostsEnd, "$entry`r`n$hostsEnd")
    }
}
if ($hostsUpdated -ne $hostsRaw) {
    [IO.File]::WriteAllText($hostsPath, $hostsUpdated, [Text.UTF8Encoding]::new($false))
    $changed.Add($hostsPath)
}

$state = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json
$entries = [System.Collections.Generic.List[object]]::new()
foreach ($entry in @($state.PolicyEntries)) { $entries.Add($entry) }
$policyRoots = @(
    'HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist'
)
foreach ($root in $policyRoots) {
    if (-not (Test-Path -Path $root)) {
        New-Item -Path $root -Force | Out-Null
    }
    $properties = Get-ItemProperty -Path $root
    $existingValues = @($properties.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { [string]$_.Value })
    $usedNames = @($properties.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' } | ForEach-Object { [int]$_.Name })
    $next = 9000
    foreach ($pattern in $browserPatterns) {
        if ($existingValues -contains $pattern) { continue }
        while ($usedNames -contains $next) { $next++ }
        $name = [string]$next
        New-ItemProperty -Path $root -Name $name -Value $pattern -PropertyType String -Force | Out-Null
        $newEntry = [pscustomobject]@{ Root = $root; Name = $name; Value = $pattern }
        $entries.Add($newEntry)
        $usedNames += $next
        $existingValues += $pattern
        $changed.Add("$root::$name")
        $next++
    }
}
$state.PolicyEntries = @($entries)
$state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
$changed.Add($statePath)

$clashPaths = @(
    (Join-Path $clashRoot 'clash-verge.yaml'),
    (Join-Path $clashRoot 'clash-verge-check.yaml')
)
$profileRoot = Join-Path $clashRoot 'profiles'
if (Test-Path -LiteralPath $profileRoot) {
    $clashPaths += Get-ChildItem -LiteralPath $profileRoot -File -Filter '*.yaml' | Select-Object -ExpandProperty FullName
}
foreach ($path in $clashPaths | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $raw = [IO.File]::ReadAllText($path)
    if ($raw -match "(?m)^\s*-\s*$([regex]::Escape($clashRule))\s*$") { continue }
    $updated = [regex]::Replace(
        $raw,
        '(?m)^(?<indent>\s*)-\s*DOMAIN-SUFFIX,b23\.tv,REJECT\s*$',
        '${indent}- DOMAIN-SUFFIX,b23.tv,REJECT' + "`r`n" + '${indent}- ' + $clashRule,
        1
    )
    if ($updated -ne $raw) {
        [IO.File]::WriteAllText($path, $updated, [Text.UTF8Encoding]::new($false))
        $changed.Add($path)
    }
}

& ipconfig.exe /flushdns | Out-Null
Get-Process -Name 'verge-mihomo' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
    CompletedAt = (Get-Date).ToString('o')
    Changed = @($changed)
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
