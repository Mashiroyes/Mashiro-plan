[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeDescriptorPath,
    [Parameter(Mandatory)][ValidateSet('CurrentUser','System','InteractiveUser')][string]$Identity,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

function Test-Child([string]$Executable, [string[]]$Arguments) {
    try {
        $Text = @(& $Executable @Arguments 2>&1)
        return [ordered]@{ ok=($LASTEXITCODE -eq 0); exitCode=$LASTEXITCODE; output=(($Text -join [Environment]::NewLine).Trim() | Select-Object -First 1) }
    } catch {
        return [ordered]@{ ok=$false; exitCode=$null; output=$_.Exception.Message }
    }
}

$Errors = [Collections.Generic.List[string]]::new()
try {
    $Runtime = Get-Content -LiteralPath $RuntimeDescriptorPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExecutableChecks = [ordered]@{}
    foreach ($Name in @('pwshPath','nodePath','pythonPath','openClawCommand')) {
        $Value = [string]$Runtime.$Name
        $Exists = [bool]($Value -and (Test-Path -LiteralPath $Value -PathType Leaf))
        $ExecutableChecks[$Name] = [ordered]@{ ok=$Exists; path=$Value }
        if (-not $Exists) { $Errors.Add("$Name missing: $Value") }
    }
    $Capabilities = [ordered]@{
        pwsh = Test-Child ([string]$Runtime.pwshPath) @('-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()')
        node = Test-Child ([string]$Runtime.nodePath) @('-e','require("node:sqlite"); process.stdout.write("ok")')
        python = Test-Child ([string]$Runtime.pythonPath) @('-c','import sqlite3; from PIL import Image; print("ok")')
    }
    foreach ($Property in $Capabilities.GetEnumerator()) {
        if (-not [bool]$Property.Value.ok) { $Errors.Add("$($Property.Key) capability failed: $($Property.Value.output)") }
    }
    $ResourcePaths = [ordered]@{
        planner = Join-Path ([string]$Runtime.planRoot) 'plugin\mashirobot-plugin-plan\planner\planner.py'
        games = Join-Path ([string]$Runtime.planRoot) 'plugin\mashirobot-plugin-game-timer\core\games.json'
        helpRenderer = Join-Path ([string]$Runtime.planRoot) 'core\menu\render_help.py'
    }
    $Resources = [ordered]@{}
    foreach ($Entry in $ResourcePaths.GetEnumerator()) {
        $Exists = Test-Path -LiteralPath $Entry.Value -PathType Leaf
        $Resources[$Entry.Key] = [ordered]@{ ok=[bool]$Exists; path=$Entry.Value }
        if (-not $Exists) { $Errors.Add("resource missing: $($Entry.Value)") }
    }
    $DatabaseExists = Test-Path -LiteralPath ([string]$Runtime.sqlitePath) -PathType Leaf
    if (-not $DatabaseExists) { $Errors.Add("database missing: $($Runtime.sqlitePath)") }
    $Result = [ordered]@{
        ok = ($Errors.Count -eq 0)
        identity = $Identity
        actualIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        executables = $ExecutableChecks
        capabilities = $Capabilities
        database = [ordered]@{ ok=[bool]$DatabaseExists; path=[string]$Runtime.sqlitePath }
        resources = $Resources
        checkedAt = [DateTimeOffset]::Now.ToString('o')
        errors = @($Errors)
    }
} catch {
    $Result = [ordered]@{ ok=$false; identity=$Identity; actualIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().Name; checkedAt=[DateTimeOffset]::Now.ToString('o'); errors=@($_.Exception.Message) }
}

$Json = $Result | ConvertTo-Json -Depth 12
if ($OutputPath) {
    $Parent = Split-Path -Parent $OutputPath
    if ($Parent) { New-Item -ItemType Directory -Path $Parent -Force | Out-Null }
    $Json | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}
$Json
if (-not $Result.ok) { exit 1 }
