# Versioned source is copied to %LOCALAPPDATA%/MashiroBot/mashirobot-plugin-block/workers.
# Keep the operational entry point identical to BlockWorker.ps1.
. (Join-Path $PSScriptRoot 'BlockWorker.ps1') @args
