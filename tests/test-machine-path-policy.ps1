$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$patterns = @(
    'D:\Program\nodejs\npm_global24',
    '-im-bot',
    '@im.wechat',
    'C:\Users\Mashiroyes',
    'D:\BaiduSyncdisk\Study\AI\codex\codex-study'
)
$files = Get-ChildItem (Join-Path $root 'core'),(Join-Path $root 'plugin'),(Join-Path $root 'focus-lock') -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\\/]tests?[\\/]' -and $_.Extension -in '.ps1','.mjs','.js','.json' -and $_.Name -ne 'machine.example.json' }
$violations = foreach ($file in $files) {
    $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
    foreach ($pattern in $patterns) {
        if ($text.Contains($pattern, [StringComparison]::OrdinalIgnoreCase)) {
            [pscustomobject]@{ file=$file.FullName.Substring($root.Length + 1); pattern=$pattern }
        }
    }
}
if ($violations) { throw "Machine-specific production references remain:`n$($violations | ConvertTo-Json -Depth 3)" }
[ordered]@{ ok=$true; checkedFiles=@($files).Count } | ConvertTo-Json -Compress
