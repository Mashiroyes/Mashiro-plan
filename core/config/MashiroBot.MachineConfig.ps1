Set-StrictMode -Version Latest

function Get-MashiroMachineConfigPath {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; cannot locate MashiroBot machine configuration.' }
    return Join-Path $env:LOCALAPPDATA 'MashiroBot\config\machine.json'
}

function Read-MashiroMachineConfig {
    param([string]$Path = (Get-MashiroMachineConfigPath))
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "MashiroBot machine configuration is missing: $Path. Run core\config\initialize-machine-config.ps1."
    }
    try { $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "MashiroBot machine configuration is invalid JSON: $Path. $($_.Exception.Message)" }
    if ([int]$config.schemaVersion -ne 1) { throw "Unsupported MashiroBot machine configuration schemaVersion in $Path." }
    return $config
}

function Resolve-MashiroOpenClawCommand {
    param($Config = (Read-MashiroMachineConfig))
    $explicit = [string]$Config.openClawCommand
    if ($explicit) {
        if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { throw "Configured OpenClaw command does not exist: $explicit" }
        return [IO.Path]::GetFullPath($explicit)
    }
    foreach ($name in @('openclaw.cmd','openclaw.ps1','openclaw')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    throw 'OpenClaw command was not found. Install OpenClaw or set openClawCommand in machine.json.'
}

function Resolve-MashiroWeixinDelivery {
    param($Config = (Read-MashiroMachineConfig), [string]$Account, [string]$Target)
    $resolvedAccount = if ($Account) { $Account } else { [string]$Config.weixinAccount }
    $resolvedTarget = if ($Target) { $Target } else { [string]$Config.weixinTarget }
    $openClaw = Resolve-MashiroOpenClawCommand -Config $Config
    if (-not $resolvedAccount) {
        try {
            $raw = & $openClaw channels status --json 2>$null
            if ($LASTEXITCODE -eq 0) {
                $status = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
                $resolvedAccount = [string]$status.channelDefaultAccountId.'openclaw-weixin'
                if (-not $resolvedAccount) { $resolvedAccount = [string]@($status.channelAccounts.'openclaw-weixin')[0].accountId }
            }
        } catch { }
    }
    if (-not $resolvedAccount) { throw 'Weixin account is missing. Set weixinAccount in machine.json.' }
    if (-not $resolvedTarget) { throw 'Weixin target is missing. Set weixinTarget in machine.json.' }
    return [pscustomobject][ordered]@{ OpenClawCommand=$openClaw; Account=$resolvedAccount; Target=$resolvedTarget }
}

function Resolve-MashiroCloudMusicPath {
    param($Config = (Read-MashiroMachineConfig))
    $configured = [string]$Config.cloudMusicPath
    if ($configured) {
        if (-not (Test-Path -LiteralPath $configured -PathType Leaf)) { throw "Configured CloudMusic executable does not exist: $configured" }
        return [IO.Path]::GetFullPath($configured)
    }
    $command = Get-Command cloudmusic.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}
