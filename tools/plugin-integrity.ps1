[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Snapshot', 'Compare')]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$PluginPath,

    [Parameter(Mandatory = $true)]
    [string]$SnapshotPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-IntegrityRows {
    param([Parameter(Mandatory = $true)][string]$Root)

    $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    $rows = @(
        Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File | ForEach-Object {
            [pscustomobject][ordered]@{
                path = [IO.Path]::GetRelativePath($resolvedRoot, $_.FullName).Replace('\', '/')
                size = [long]$_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        } | Sort-Object -Property path
    )
    return $rows
}

function ConvertTo-StableJson {
    param([Parameter(Mandatory = $true)][object[]]$Rows)

    return ConvertTo-Json -InputObject @($Rows) -Depth 4
}

if (-not (Test-Path -LiteralPath $PluginPath -PathType Container)) {
    throw "PluginPath does not exist or is not a directory: $PluginPath"
}

$currentRows = @(Get-IntegrityRows -Root $PluginPath)
$snapshotFullPath = [IO.Path]::GetFullPath($SnapshotPath)

if ($Mode -eq 'Snapshot') {
    $snapshotDirectory = Split-Path -Parent $snapshotFullPath
    if ([string]::IsNullOrWhiteSpace($snapshotDirectory)) {
        throw "SnapshotPath must have a parent directory: $SnapshotPath"
    }
    [IO.Directory]::CreateDirectory($snapshotDirectory) | Out-Null
    $temporaryPath = Join-Path $snapshotDirectory ('.{0}.{1}.tmp' -f [IO.Path]::GetFileName($snapshotFullPath), [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($temporaryPath, (ConvertTo-StableJson -Rows $currentRows) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $snapshotFullPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
    Write-Output $snapshotFullPath
    exit 0
}

if (-not (Test-Path -LiteralPath $snapshotFullPath -PathType Leaf)) {
    throw "Snapshot does not exist: $snapshotFullPath"
}

try {
    $snapshotValue = Get-Content -LiteralPath $snapshotFullPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    throw "Snapshot is not valid JSON: $snapshotFullPath. $($_.Exception.Message)"
}

$expectedRows = @($snapshotValue)
$expectedByPath = @{}
foreach ($row in $expectedRows) {
    if ($null -eq $row.path -or $null -eq $row.size -or $null -eq $row.sha256) {
        throw "Snapshot row is missing path, size, or sha256: $snapshotFullPath"
    }
    $relativePath = [string]$row.path
    if ($expectedByPath.ContainsKey($relativePath)) {
        throw "Snapshot contains a duplicate path: $relativePath"
    }
    $expectedByPath[$relativePath] = $row
}

$currentByPath = @{}
foreach ($row in $currentRows) {
    $currentByPath[[string]$row.path] = $row
}

$differences = [Collections.Generic.List[string]]::new()
foreach ($relativePath in @($expectedByPath.Keys | Sort-Object)) {
    if (-not $currentByPath.ContainsKey($relativePath)) {
        $differences.Add("removed: $relativePath")
        continue
    }
    $expected = $expectedByPath[$relativePath]
    $current = $currentByPath[$relativePath]
    if ([long]$expected.size -ne [long]$current.size -or [string]$expected.sha256 -cne [string]$current.sha256) {
        $differences.Add("changed: $relativePath")
    }
}
foreach ($relativePath in @($currentByPath.Keys | Sort-Object)) {
    if (-not $expectedByPath.ContainsKey($relativePath)) {
        $differences.Add("added: $relativePath")
    }
}

if ($differences.Count -gt 0) {
    foreach ($difference in $differences) {
        [Console]::Error.WriteLine($difference)
    }
    exit 2
}

Write-Output 'integrity: unchanged'
exit 0
