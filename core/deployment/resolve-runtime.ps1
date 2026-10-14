[CmdletBinding()]
param(
    [string]$PlanRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$SqlitePath,
    [string]$PwshPath,
    [string]$NodePath,
    [string]$PythonPath,
    [string]$OpenClawCommand,
    [string]$OpenClawPackageRoot,
    [string]$OutputPath,
    [switch]$SkipIdentityProbes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

function Resolve-Executable([string]$Explicit, [string[]]$Names, [string]$Label) {
    if ($Explicit) {
        $Resolved = [IO.Path]::GetFullPath($Explicit)
        if (-not (Test-Path -LiteralPath $Resolved -PathType Leaf)) { throw "$Label does not exist: $Resolved" }
        return $Resolved
    }
    foreach ($Name in $Names) {
        $Command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($Command -and $Command.Source) { return [IO.Path]::GetFullPath($Command.Source) }
    }
    throw "$Label was not found."
}

function Invoke-Capability([string]$Executable, [string[]]$Arguments, [string]$Label) {
    $Output = @(& $Executable @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "$Label capability check failed (exit $LASTEXITCODE): $($Output -join [Environment]::NewLine)" }
    return ($Output -join [Environment]::NewLine).Trim()
}

function Resolve-WeixinPackage([string]$ExplicitRoot) {
    if ($ExplicitRoot) {
        $Root = [IO.Path]::GetFullPath($ExplicitRoot)
        if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Tencent Weixin package root does not exist: $Root" }
        return $Root
    }
    $Projects = Join-Path $env:USERPROFILE '.openclaw\npm\projects'
    $Candidates = @(
        Get-ChildItem -LiteralPath $Projects -Directory -Filter 'tencent-weixin-openclaw-weixin-*' -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'node_modules\@tencent-weixin\openclaw-weixin' } |
            Where-Object { Test-Path -LiteralPath (Join-Path $_ 'package.json') -PathType Leaf }
    )
    if ($Candidates.Count -ne 1) { throw "Expected exactly one Tencent Weixin package, found $($Candidates.Count)." }
    return [IO.Path]::GetFullPath($Candidates[0])
}

$ResolvedPlanRoot = [IO.Path]::GetFullPath($PlanRoot)
if (-not $SqlitePath) { $SqlitePath = Join-Path $ResolvedPlanRoot 'sqlite\openclaw-planner.sqlite' }
if (-not $OutputPath) {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; cannot publish runtime descriptor.' }
    $OutputPath = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\runtime.json'
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$ResolvedSqlite = [IO.Path]::GetFullPath($SqlitePath)
if (-not (Test-Path -LiteralPath $ResolvedSqlite -PathType Leaf)) { throw "Planner database does not exist: $ResolvedSqlite" }

$ResolvedPwsh = Resolve-Executable $PwshPath @('pwsh.exe','pwsh') 'PowerShell 7'
$ResolvedNode = Resolve-Executable $NodePath @('node.exe','node') 'Node.js'
$ResolvedPython = Resolve-Executable $PythonPath @('python.exe','python') 'Python'
$ResolvedOpenClaw = Resolve-Executable $OpenClawCommand @('openclaw.cmd','openclaw.ps1','openclaw') 'OpenClaw command'
$ResolvedPackage = Resolve-WeixinPackage $OpenClawPackageRoot

$PwshVersion = Invoke-Capability $ResolvedPwsh @('-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()') 'PowerShell 7'
$NodeVersion = Invoke-Capability $ResolvedNode @('-e','require("node:sqlite"); process.stdout.write(process.version)') 'Node.js node:sqlite'
$PythonVersionText = Invoke-Capability $ResolvedPython @('-c','import sys, sqlite3; from PIL import Image; print(".".join(map(str, sys.version_info[:3])))') 'Python sqlite3/Pillow'
$PythonVersion = [version]$PythonVersionText
if ($PythonVersion.Major -ne 3 -or $PythonVersion.Minor -lt 11 -or $PythonVersion.Minor -gt 13) {
    throw "Python $PythonVersionText is not in the validated range 3.11-3.13."
}

$PackageJsonPath = Join-Path $ResolvedPackage 'package.json'
if (-not (Test-Path -LiteralPath $PackageJsonPath -PathType Leaf)) { throw "Tencent Weixin package.json is missing: $PackageJsonPath" }
$PackageJson = Get-Content -LiteralPath $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$LayoutRegistryPath = Join-Path $ResolvedPlanRoot 'core\adapter\openclaw-layouts.json'
if (-not (Test-Path -LiteralPath $LayoutRegistryPath -PathType Leaf)) { throw "OpenClaw layout registry is missing: $LayoutRegistryPath" }
$LayoutRegistry = Get-Content -LiteralPath $LayoutRegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$LayoutMatches = @($LayoutRegistry.layouts | Where-Object { @($_.versions) -contains [string]$PackageJson.version })
if ($LayoutMatches.Count -ne 1) { throw "Unsupported Tencent Weixin package version/layout during preflight: $($PackageJson.version)" }
$ResolvedLayout = $LayoutMatches[0]
foreach ($RelativePath in @([string]$ResolvedLayout.fastRoutinePath,[string]$ResolvedLayout.processMessagePath)) {
    $Candidate = Join-Path $ResolvedPackage ($RelativePath -replace '/', '\')
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { throw "Recognized OpenClaw layout $($ResolvedLayout.id) is missing: $Candidate" }
}
$InteractiveUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$ClashRoot = if ($env:APPDATA) { Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev' } else { $null }
$Descriptor = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::Now.ToString('o')
    planRoot = $ResolvedPlanRoot
    sqlitePath = $ResolvedSqlite
    pwshPath = $ResolvedPwsh
    nodePath = $ResolvedNode
    pythonPath = $ResolvedPython
    openClawCommand = $ResolvedOpenClaw
    openClawPackageRoot = $ResolvedPackage
    openClawPackageVersion = [string]$PackageJson.version
    openClawLayoutId = [string]$ResolvedLayout.id
    interactiveUser = $InteractiveUser
    versions = [ordered]@{ pwsh=$PwshVersion; node=$NodeVersion; python=$PythonVersionText }
    clash = [ordered]@{
        installed = [bool]($ClashRoot -and (Test-Path -LiteralPath $ClashRoot -PathType Container))
        configRoot = $ClashRoot
        liveConfigPath = if ($ClashRoot) { Join-Path $ClashRoot 'clash-verge.yaml' } else { $null }
        reloadTransports = @('http','named-pipe')
    }
    identityProbes = @()
}

$Directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Path $Directory -Force | Out-Null
$Temporary = "$OutputPath.tmp-$([guid]::NewGuid().ToString('N'))"
try {
    $Descriptor | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Temporary -Encoding UTF8
    $RoundTrip = Get-Content -LiteralPath $Temporary -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$RoundTrip.schemaVersion -ne 1) { throw 'Runtime descriptor round-trip validation failed.' }
if (-not $SkipIdentityProbes) {
        $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
        if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'Identity probes require an elevated PowerShell 7 window because temporary SYSTEM and interactive-user tasks must be registered.'
        }
        $Probe = Join-Path $PSScriptRoot 'probe-identity.ps1'
        if (-not (Test-Path -LiteralPath $Probe -PathType Leaf)) { throw "Identity probe is missing: $Probe" }
        $IdentityResults = [Collections.Generic.List[object]]::new()
        $CurrentJson = @(& $ResolvedPwsh -NoProfile -NonInteractive -File $Probe -RuntimeDescriptorPath $Temporary -Identity CurrentUser 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "CurrentUser identity probe failed: $($CurrentJson -join [Environment]::NewLine)" }
        $IdentityResults.Add((($CurrentJson -join [Environment]::NewLine) | ConvertFrom-Json))

        $RunId = [guid]::NewGuid().ToString('N')
        $ProbeRoot = Join-Path $env:ProgramData "MashiroBot\deployments\probes-$RunId"
        New-Item -ItemType Directory -Path $ProbeRoot -Force | Out-Null
        try {
            foreach ($IdentityName in @('System','InteractiveUser')) {
                $TaskName = "MashiroBot-DeployProbe-$RunId-$IdentityName"
                $ProbeOutput = Join-Path $ProbeRoot "$IdentityName.json"
                $Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -RuntimeDescriptorPath "{1}" -Identity {2} -OutputPath "{3}"' -f $Probe,$Temporary,$IdentityName,$ProbeOutput
                $Action = New-ScheduledTaskAction -Execute $ResolvedPwsh -Argument $Arguments
                if ($IdentityName -eq 'System') {
                    $Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
                } else {
                    $Principal = New-ScheduledTaskPrincipal -UserId $InteractiveUser -LogonType Interactive -RunLevel Limited
                }
                $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 20) -StartWhenAvailable
                Register-ScheduledTask -TaskName $TaskName -Action $Action -Principal $Principal -Settings $Settings -Force | Out-Null
                try {
                    Start-ScheduledTask -TaskName $TaskName
                    $Deadline = (Get-Date).AddSeconds(20)
                    while (-not (Test-Path -LiteralPath $ProbeOutput -PathType Leaf) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 200 }
                    if (-not (Test-Path -LiteralPath $ProbeOutput -PathType Leaf)) {
                        $Info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
                        throw "$IdentityName identity probe timed out; task last result=$($Info.LastTaskResult)"
                    }
                    $Result = Get-Content -LiteralPath $ProbeOutput -Raw -Encoding UTF8 | ConvertFrom-Json
                    if (-not $Result.ok) { throw "$IdentityName identity probe failed: $($Result.errors -join '; ')" }
                    $IdentityResults.Add($Result)
                } finally {
                    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
                }
            }
            $Descriptor.identityProbes = @($IdentityResults)
            $Descriptor | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Temporary -Encoding UTF8
        } finally {
            Remove-Item -LiteralPath $ProbeRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Move-Item -LiteralPath $Temporary -Destination $OutputPath -Force
} finally {
    Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
}
$Descriptor | ConvertTo-Json -Depth 10
