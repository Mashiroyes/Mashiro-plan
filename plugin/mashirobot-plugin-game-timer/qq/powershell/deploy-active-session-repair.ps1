[CmdletBinding()]param()
$ErrorActionPreference='Stop'
$focusSource=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..\focus-lock\FocusLock.ps1')).Path
$focusTarget=Join-Path $env:ProgramData 'CodexFocusLock\FocusLock.ps1'
$backupRoot=Join-Path $env:ProgramData ('MashiroBot\migration-backups\qq-ifeo-repair-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupRoot -Force|Out-Null
Copy-Item -LiteralPath $focusTarget -Destination (Join-Path $backupRoot 'FocusLock.ps1.before-ifeo-sync')
Copy-Item -LiteralPath $focusSource -Destination $focusTarget -Force
$pluginRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$db=(Resolve-Path (Join-Path $pluginRoot '..\..\sqlite\openclaw-planner.sqlite')).Path
& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-qq-session.ps1') -Mode Install -SqlitePath $db|Out-Null
[ordered]@{ok=$true;backup=$backupRoot}|ConvertTo-Json -Compress
