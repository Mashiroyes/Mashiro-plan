$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('timeout-reading-prompt-' + [guid]::NewGuid().ToString('N'))
$helper = Join-Path (Split-Path -Parent $PSScriptRoot) 'TimeoutReadingPrompt.ps1'
$wrapper = Join-Path (Split-Path -Parent $PSScriptRoot) 'QQCooldownPrompt.ps1'
function Assert-True($value, $message) { if (-not $value) { throw $message } }
try {
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $pdf = Join-Path $root 'book.pdf'
    Set-Content -LiteralPath $pdf -Value fixture -Encoding UTF8
    $first = & $helper -Mode Submit -EventKey 'qq:one:end' -StateRoot $root -PdfPath $pdf -FixtureMode | ConvertFrom-Json
    $repeat = & $helper -Mode Submit -EventKey 'qq:one:end' -StateRoot $root -PdfPath $pdf -FixtureMode | ConvertFrom-Json
    Assert-True $first.opened 'First event was not accepted.'
    Assert-True $repeat.duplicate 'Repeated event was not deduplicated.'
    $status = Join-Path $root 'status.json'
    [pscustomobject]@{ phase='cooldown'; clientBarrierActive=$true; session=[pscustomobject]@{ cooldownEndsAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o') } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $status -Encoding UTF8
    & $wrapper -StatusPath $status -TimeoutPrompt $helper -FixtureMode
    [pscustomobject]@{ phase='ready'; clientBarrierActive=$true; session=[pscustomobject]@{ cooldownEndsAt=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('o') } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $status -Encoding UTF8
    & $wrapper -StatusPath $status -TimeoutPrompt $helper -FixtureMode
    'PASS: timeout helper deduplicates events and cooldown wrapper guards state.'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

