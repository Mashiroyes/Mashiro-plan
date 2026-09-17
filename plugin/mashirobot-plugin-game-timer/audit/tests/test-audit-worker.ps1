[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$project = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\MashiroBot.UsageAudit.csproj'
$outputRoot = Join-Path $env:TEMP ("mashiro-audit-test-" + [guid]::NewGuid().ToString('N'))
$publishRoot = Join-Path $outputRoot 'publish'
$targets = Join-Path $outputRoot 'targets.json'

try {
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    @{
        targets = @(@{
            key = 'fixture'
            displayName = 'Fixture'
            kind = 'game'
            executablePath = (Join-Path $outputRoot 'fixture.exe')
        })
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $targets -Encoding UTF8

    & dotnet publish $project -c Release -r win-x64 --self-contained false -o $publishRoot | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Audit worker publish failed.' }
    $worker = Join-Path $publishRoot 'MashiroBot.UsageAudit.exe'
    $projectXml = [xml](Get-Content -LiteralPath $project -Raw)
    if ([string]$projectXml.Project.PropertyGroup.OutputType -ne 'WinExe') {
        throw 'Audit worker must use the Windows GUI subsystem so no console window is created.'
    }
    $process = Start-Process -FilePath $worker -ArgumentList @('--self-test','--fixture-targets',('"{0}"' -f $targets)) -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Audit worker self-test failed with exit code $($process.ExitCode)." }
    [pscustomobject]@{ ok = $true; worker = $worker; outputType = 'WinExe'; exitCode = $process.ExitCode } | ConvertTo-Json -Compress
}
finally {
    if (Test-Path -LiteralPath $outputRoot) {
        for ($attempt = 1; $attempt -le 10; $attempt++) {
            try {
                Remove-Item -LiteralPath $outputRoot -Recurse -Force -ErrorAction Stop
                break
            }
            catch {
                if ($attempt -eq 10) { throw }
                Start-Sleep -Milliseconds 200
            }
        }
    }
}
