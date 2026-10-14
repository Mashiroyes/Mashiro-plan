$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PlanRoot = Split-Path -Parent $PSScriptRoot
$Resolver = Join-Path $PlanRoot 'core\deployment\resolve-runtime.ps1'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('MashiroRuntime-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root | Out-Null

function New-FakeCommand([string]$Name, [string]$Output, [int]$ExitCode = 0) {
    $Path = Join-Path $Root "$Name.cmd"
    @("@echo off", "echo $Output", "exit /b $ExitCode") | Set-Content -LiteralPath $Path -Encoding ASCII
    return $Path
}

function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "ASSERTION FAILED: $Message" }
}

try {
    $PackageRoot = Join-Path $Root 'weixin'
    New-Item -ItemType Directory -Path (Join-Path $PackageRoot 'dist\src\messaging') -Force | Out-Null
    @{ name='@tencent-weixin/openclaw-weixin'; version='2.4.8' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PackageRoot 'package.json') -Encoding UTF8
    'export function handleFastRoutineCommand(){}' | Set-Content -LiteralPath (Join-Path $PackageRoot 'dist\src\messaging\fast-routine.js') -Encoding UTF8
    'import "./fast-routine.js"; const fastRoutineResult = true;' | Set-Content -LiteralPath (Join-Path $PackageRoot 'dist\src\messaging\process-message.js') -Encoding UTF8
    $Database = Join-Path $Root 'planner.sqlite'
    [IO.File]::WriteAllBytes($Database, [byte[]](1,2,3))
    $Pwsh = New-FakeCommand 'pwsh' '7.6.6'
    $Node = New-FakeCommand 'node' 'v22.22.0'
    $Python = New-FakeCommand 'python' '3.13.7'
    $OpenClaw = New-FakeCommand 'openclaw' 'openclaw'
    $Output = Join-Path $Root 'runtime.json'

    & $Resolver -PlanRoot $PlanRoot -SqlitePath $Database -PwshPath $Pwsh -NodePath $Node -PythonPath $Python `
        -OpenClawCommand $OpenClaw -OpenClawPackageRoot $PackageRoot -OutputPath $Output -SkipIdentityProbes | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'valid fixture must resolve'
    Assert-True (Test-Path -LiteralPath $Output -PathType Leaf) 'valid fixture must publish runtime.json'
    $Runtime = Get-Content -LiteralPath $Output -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($Runtime.pythonPath -eq $Python) 'descriptor must contain the resolved Python path'
    Assert-True ($Runtime.openClawPackageVersion -eq '2.4.8') 'descriptor must contain the package version'
    Assert-True ($Runtime.openClawLayoutId -eq 'tencent-weixin-2.4.x-messaging-v1') 'descriptor must contain the recognized layout id'

    $BadPython = New-FakeCommand 'python314' '3.14.0'
    $BadOutput = Join-Path $Root 'runtime-bad.json'
    $Failed = $false
    try {
        & $Resolver -PlanRoot $PlanRoot -SqlitePath $Database -PwshPath $Pwsh -NodePath $Node -PythonPath $BadPython `
            -OpenClawCommand $OpenClaw -OpenClawPackageRoot $PackageRoot -OutputPath $BadOutput -SkipIdentityProbes | Out-Null
    } catch {
        $Failed = $_.Exception.Message -match 'Python 3\.14\.0 is not in the validated range 3\.11-3\.13'
    }
    Assert-True $Failed 'Python 3.14 must fail with the validated-range diagnostic'
    Assert-True (-not (Test-Path -LiteralPath $BadOutput)) 'failed discovery must not publish runtime.json'
    Write-Output 'PASS: runtime descriptor resolution and version gating'
} finally {
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
