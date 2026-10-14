$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PlanRoot = Split-Path -Parent $PSScriptRoot
$Probe = Join-Path $PlanRoot 'core\deployment\probe-identity.ps1'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('MashiroProbe-' + [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw "ASSERTION FAILED: $Message" } }

try {
    New-Item -ItemType Directory -Path $Root | Out-Null
    $Runtime = [ordered]@{
        schemaVersion=1; planRoot=$PlanRoot; sqlitePath=(Join-Path $PlanRoot 'sqlite\openclaw-planner.sqlite')
        pwshPath=(Get-Command pwsh.exe).Source; nodePath=(Get-Command node.exe).Source; pythonPath=(Get-Command python.exe).Source
        openClawCommand=(Get-Command pwsh.exe).Source; openClawPackageRoot=$Root; interactiveUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    }
    $Descriptor = Join-Path $Root 'runtime.json'
    $Runtime | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Descriptor -Encoding UTF8
    foreach ($Identity in @('CurrentUser','System','InteractiveUser')) {
        $Json = @(& $Probe -RuntimeDescriptorPath $Descriptor -Identity $Identity 2>&1) -join [Environment]::NewLine
        Assert-True ($LASTEXITCODE -eq 0) "$Identity fixture probe must pass: $Json"
        $Result = $Json | ConvertFrom-Json
        Assert-True ($Result.identity -eq $Identity) "$Identity result must retain requested identity"
        Assert-True ($Result.resources.planner.ok -and $Result.resources.games.ok -and $Result.resources.helpRenderer.ok) 'all real repository resources must resolve'
    }

    $BadRoot = Join-Path $Root 'missing-resources'
    New-Item -ItemType Directory -Path $BadRoot | Out-Null
    $Runtime.planRoot = $BadRoot
    $Runtime | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Descriptor -Encoding UTF8
    $BadJson = @(& $Probe -RuntimeDescriptorPath $Descriptor -Identity CurrentUser 2>&1) -join [Environment]::NewLine
    Assert-True ($LASTEXITCODE -ne 0) 'missing resources must fail the probe'
    $Bad = $BadJson | ConvertFrom-Json
    Assert-True (-not $Bad.resources.planner.ok) 'missing planner.py must be named independently'
    Assert-True (($Bad.errors -join ' ') -match 'planner\\planner\.py') 'error must contain the actual missing planner path'
    Write-Output 'PASS: identity-specific deployment preflight contract'
} finally {
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
