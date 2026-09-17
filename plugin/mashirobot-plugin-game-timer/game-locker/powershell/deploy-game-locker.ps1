[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$pluginRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path;$planRoot=(Resolve-Path (Join-Path $pluginRoot '..\..')).Path
$db=(Resolve-Path (Join-Path $planRoot 'sqlite\openclaw-planner.sqlite')).Path;$backup=Join-Path $env:ProgramData ('MashiroBot\migration-backups\game-locker-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $pluginRoot 'core\games.json') -Destination (Join-Path $backup 'games.json')
Copy-Item -LiteralPath $db -Destination (Join-Path $backup 'openclaw-planner.sqlite')
foreach($suffix in @('-wal','-shm')){if(Test-Path -LiteralPath ($db+$suffix)){Copy-Item -LiteralPath ($db+$suffix) -Destination (Join-Path $backup ('openclaw-planner.sqlite'+$suffix))}}
$installed=Join-Path $env:LOCALAPPDATA 'MashiroBot\game-timer\workers';New-Item -ItemType Directory -Path $installed -Force|Out-Null
foreach($name in @('game-timer-worker-v1.ps1','game-timer-db-v1.mjs')){if(Test-Path (Join-Path $installed $name)){Copy-Item (Join-Path $installed $name) (Join-Path $backup ($name+'.before'))};Copy-Item (Join-Path $pluginRoot ('powershell\'+$name)) (Join-Path $installed $name)-Force}
Get-ScheduledTask -TaskName 'MashiroBot-GameLocker-*' -ErrorAction SilentlyContinue|ForEach-Object{Export-ScheduledTask -TaskName $_.TaskName|Set-Content -LiteralPath (Join-Path $backup ($_.TaskName+'.xml')) -Encoding UTF8}
& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-game-locker.ps1') -Mode Install -SqlitePath $db
