[CmdletBinding()]
param(
    [ValidateRange(1,60)][int]$Minutes = 20,
    [string]$StateRoot = (Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq')
)
$ErrorActionPreference = 'Stop'
$path = Join-Path $StateRoot 'before-noon-release.json'
$now = [DateTimeOffset]::Now
$expires = $now.AddMinutes($Minutes)
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
$temporary = "$path.$([guid]::NewGuid().ToString('N')).tmp"
[ordered]@{
    purpose = 'qq-before-noon-test'
    issuedAt = $now.ToString('o')
    expiresAt = $expires.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
Move-Item -LiteralPath $temporary -Destination $path -Force
[ordered]@{ ok=$true; path=$path; expiresAt=$expires.ToString('o') } | ConvertTo-Json -Compress
