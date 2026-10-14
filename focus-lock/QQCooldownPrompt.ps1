[CmdletBinding()]
param(
    [string]$StatusPath = (Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq\last-status.json'),
    [string]$TimeoutPrompt = (Join-Path $env:ProgramData 'CodexFocusLock\TimeoutReadingPrompt.ps1'),
    [switch]$FixtureMode
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-ActiveCooldown {
    if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) { return $false }
    try {
        $status = Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$status.phase -ne 'cooldown' -or -not [bool]$status.clientBarrierActive) { return $false }
        if (-not $status.session -or -not $status.session.cooldownEndsAt) { return $false }
        return [DateTimeOffset]::UtcNow -lt [DateTimeOffset]::Parse([string]$status.session.cooldownEndsAt).ToUniversalTime()
    } catch { return $false }
}

try {
    if ((Test-ActiveCooldown) -and (Test-Path -LiteralPath $TimeoutPrompt -PathType Leaf)) {
        & $TimeoutPrompt -Mode Open -FixtureMode:$FixtureMode | Out-Null
    }
} catch {
    # An IFEO debugger must never become an alternate launcher when the prompt fails.
}
exit 0

