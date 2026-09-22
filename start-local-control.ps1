[CmdletBinding()]
param([switch]$Foreground)
$target = Join-Path $PSScriptRoot 'core\local-ui\start-local-control.ps1'
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Local console launcher is missing: $target" }
& $target -Foreground:$Foreground
