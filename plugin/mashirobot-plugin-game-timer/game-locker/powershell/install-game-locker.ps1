[CmdletBinding()]
param(
 [ValidateSet('Install','Status','Run','Remove')][string]$Mode='Status',
 [string]$SqlitePath,
 [string]$StateRoot=(Join-Path $env:ProgramData 'MashiroBot\game-locker')
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$taskName='MashiroBot-GameLocker-Reconcile';$workerRoot=Join-Path $StateRoot 'workers';$vaultRoot=Join-Path $StateRoot 'vault'
$worker=Join-Path $workerRoot 'game-locker-worker-v1.ps1';$helper=Join-Path $workerRoot 'game-locker-db-v1.mjs';$configPath=Join-Path $StateRoot 'config.json'
function Admin {$id=[Security.Principal.WindowsIdentity]::GetCurrent();[Security.Principal.WindowsPrincipal]::new($id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}
function Require-Admin {if(-not (Admin)){throw 'Administrator rights are required.'}}
function Grant-RunAccess {$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$service=New-Object -ComObject 'Schedule.Service';$service.Connect();$task=$service.GetFolder('\').GetTask($taskName);$sddl=[string]$task.GetSecurityDescriptor(0xF);$ace="(A;;GRGX;;;$sid)";if(-not$sddl.Contains($ace)){if($sddl-match'S:'){$sddl=$sddl-replace'S:',($ace+'S:')}else{$sddl+=$ace};$task.SetSecurityDescriptor($sddl,0)}}
function Status {$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;$process=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object{$_.CommandLine-match'game-locker-worker-v1\.ps1'});$counts=$null;if(Test-Path $configPath){$c=Get-Content -Raw $configPath|ConvertFrom-Json;$counts=& node $helper status ([string]$c.SqlitePath)|ConvertFrom-Json};[ordered]@{ok=[bool]($task-and(Test-Path $worker));task=if($task){@{name=$task.TaskName;state=[string]$task.State}}else{$null};idleProcessCount=$process.Count;counts=$counts;vaultRoot=$vaultRoot}|ConvertTo-Json -Depth 6}
function Install {
 Require-Admin;if(-not $SqlitePath){throw 'Install requires -SqlitePath.'};$db=[IO.Path]::GetFullPath($SqlitePath)
 New-Item -ItemType Directory -Path $workerRoot,$vaultRoot -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'game-locker-worker-v1.ps1') -Destination $worker -Force;Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'game-locker-db-v1.mjs') -Destination $helper -Force
 & icacls.exe $vaultRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'|Out-Null;if($LASTEXITCODE -ne 0){throw 'Failed to protect vault ACL.'}
 @{SqlitePath=$db;StateRoot=$StateRoot;InstalledAt=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $configPath -Encoding UTF8
 $pwsh=(Get-Command pwsh.exe).Source;$args='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode Reconcile -SqlitePath "{1}" -StateRoot "{2}"'-f$worker,$db,$StateRoot
 $action=New-ScheduledTaskAction -Execute $pwsh -Argument $args;$triggers=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
 $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
 Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force|Out-Null;Grant-RunAccess
 & node $helper status $db|Out-Null;Status
}
switch($Mode){'Install'{Install}'Status'{Status}'Run'{Start-ScheduledTask -TaskName $taskName;@{ok=$true}|ConvertTo-Json -Compress}'Remove'{Require-Admin;Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue;@{ok=$true}|ConvertTo-Json -Compress}}
