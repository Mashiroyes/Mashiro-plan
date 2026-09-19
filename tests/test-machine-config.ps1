$ErrorActionPreference = 'Stop'
$module = Join-Path (Split-Path -Parent $PSScriptRoot) 'core\config\MashiroBot.MachineConfig.ps1'
Import-Module $module -Force
$root = Join-Path $env:TEMP ('mashiro-machine-config-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $configPath = Join-Path $root 'machine.json'
    @{ schemaVersion=1; openClawCommand=(Get-Command pwsh.exe).Source; weixinAccount='account'; weixinTarget='target'; cloudMusicPath=''; gameExecutableOverrides=@{} } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
    $config = Read-MashiroMachineConfig -Path $configPath
    if ($config.weixinTarget -ne 'target') { throw 'Target was not loaded.' }
    $delivery = Resolve-MashiroWeixinDelivery -Config $config
    if ($delivery.Account -ne 'account' -or $delivery.Target -ne 'target') { throw 'Delivery resolution failed.' }
    $missing = $false
    try { Read-MashiroMachineConfig -Path (Join-Path $root 'missing.json') | Out-Null } catch { $missing = $_.Exception.Message -match 'initialize-machine-config' }
    if (-not $missing) { throw 'Missing configuration did not produce an actionable error.' }
    [ordered]@{ ok=$true; configPath=$configPath } | ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
