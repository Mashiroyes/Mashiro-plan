$ErrorActionPreference = 'Stop'

$planRoot = Split-Path -Parent $PSScriptRoot
$productionFiles = @(
    'core\health\check-mashirobot.ps1',
    'plugin\mashirobot-plugin-plan\bridge\planner-runner.mjs',
    'plugin\mashirobot-plugin-plan\health.mjs',
    'plugin\mashirobot-plugin-plan\windows\reminder-common.ps1',
    'plugin\mashirobot-plugin-plan\windows\english-skills-worker.ps1',
    'plugin\mashirobot-plugin-plan\windows\install-english-skills.ps1',
    'plugin\mashirobot-plugin-status\index.mjs'
)
$forbidden = @('OPENCLAW_PYTHON_PATH', 'MASHIROBOT_PYTHON', 'pythoncore-3.14-64', 'context.pythonExecutable')

foreach ($relativePath in $productionFiles) {
    $path = Join-Path $planRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing production source: $relativePath" }
    $source = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    foreach ($token in $forbidden) {
        if ($source.Contains($token)) { throw "System Python policy violation in ${relativePath}: $token" }
    }
}

$python = (Get-Command python.exe -ErrorAction Stop).Source
& $python -c 'from PIL import Image; print(Image.__version__)' *> $null
if ($LASTEXITCODE -ne 0) { throw 'System python.exe cannot import Pillow.' }

[pscustomobject]@{ ok = $true; python = $python; checkedFiles = $productionFiles.Count } | ConvertTo-Json -Compress
