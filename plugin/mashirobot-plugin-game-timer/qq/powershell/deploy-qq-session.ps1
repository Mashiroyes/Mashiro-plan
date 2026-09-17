[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$sourceRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\..\focus-lock')).Path
$pluginRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$db=(Resolve-Path (Join-Path $pluginRoot '..\..\sqlite\openclaw-planner.sqlite')).Path
$focusRoot=Join-Path $env:ProgramData 'CodexFocusLock'
$backup=Join-Path $env:ProgramData ('MashiroBot\migration-backups\qq-session-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force|Out-Null
Copy-Item -LiteralPath $db -Destination (Join-Path $backup 'openclaw-planner.sqlite.before') -Force
foreach($suffix in @('-wal','-shm')){if(Test-Path -LiteralPath ($db+$suffix)){Copy-Item -LiteralPath ($db+$suffix) -Destination (Join-Path $backup ('openclaw-planner.sqlite'+$suffix+'.before')) -Force}}
Copy-Item -LiteralPath (Join-Path $focusRoot 'FocusLock.ps1') -Destination (Join-Path $backup 'FocusLock.ps1.before-qq-session') -Force
if(Test-Path -LiteralPath (Join-Path $focusRoot 'state.json')){Copy-Item -LiteralPath (Join-Path $focusRoot 'state.json') -Destination $backup -Force}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'FocusLock.ps1') -Destination (Join-Path $focusRoot 'FocusLock.ps1') -Force
Stop-ScheduledTask -TaskName 'MashiroBot-QQSession-Reconcile' -ErrorAction SilentlyContinue
& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-qq-session.ps1') -Mode Install -SqlitePath $db | Out-Null

$old=Get-ChildItem -LiteralPath (Join-Path $focusRoot 'quarantine') -File -ErrorAction SilentlyContinue|Where-Object Name -Match '(?:^|__)(QQ|QQNT|TencentQQ|QQInstaller|QQSetup|TIM).+\.(exe|msi)$'|Select-Object -First 1
if($old){
 $match=[regex]::Match($old.Name,'(?:^|__)((QQ|QQNT|TencentQQ|QQInstaller|QQSetup|TIM).+\.(exe|msi))$')
 $originalName=$match.Groups[1].Value
 $renamed=Join-Path $old.DirectoryName $originalName
 if($old.FullName-ne$renamed){if(Test-Path -LiteralPath $renamed){throw "Migration destination already exists: $renamed"};Move-Item -LiteralPath $old.FullName -Destination $renamed}
 try{& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-qq-session.ps1') -Mode Capture -SqlitePath $db -InstallerPath $renamed|Out-Null}
 catch{if($old.FullName-ne$renamed-and(Test-Path -LiteralPath $renamed)){Move-Item -LiteralPath $renamed -Destination $old.FullName};throw}
 Remove-Item -LiteralPath ($old.FullName+'.origin.txt') -Force -ErrorAction SilentlyContinue
}
& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $focusRoot 'FocusLock.ps1') -Mode Reapply|Out-Null
Start-ScheduledTask -TaskName 'MashiroBot-QQSession-Reconcile'
$status=& pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-qq-session.ps1') -Mode Status -SqlitePath $db|ConvertFrom-Json
[ordered]@{ok=$status.ok;backup=$backup;executableReady=$status.status.executableReady;websiteBlockActive=$status.status.websiteBlockActive;clientBarrierActive=$status.status.clientBarrierActive;qqInstalled=$status.status.qqInstalled}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $backup 'deployment-result.json') -Encoding UTF8
