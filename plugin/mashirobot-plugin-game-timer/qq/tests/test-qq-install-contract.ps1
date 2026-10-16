[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$powerShellRoot=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell'
$installer=Get-Content -LiteralPath (Join-Path $powerShellRoot 'install-qq-session.ps1') -Raw -Encoding UTF8
$worker=Get-Content -LiteralPath (Join-Path $powerShellRoot 'qq-session-worker-v1.ps1') -Raw -Encoding UTF8
$deploy=Get-Content -LiteralPath (Join-Path $powerShellRoot 'deploy-qq-session.ps1') -Raw -Encoding UTF8
$scheduler=Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\core\qq-session-scheduler.mjs') -Raw -Encoding UTF8
foreach($required in @('MashiroBot-QQSession-ManualRestore','MashiroBot-QQSession-ManualProtect','MashiroBot-QQSession-MaintenanceRestore','qq-executable-container-v2.ps1','ContainerConfigPath')){
 if($installer-notmatch[regex]::Escape($required)){throw "Installer is missing required contract: $required"}
}
if($installer -notmatch "(?s)New-ScheduledTaskPrincipal\s+-UserId\s+'SYSTEM'.*?-RunLevel\s+Highest"){throw 'Vault-changing tasks are not based on SYSTEM/Highest principal.'}
if($installer -notmatch '(?s)LaunchInteractive.*?LogonType\s+Interactive.*?RunLevel\s+Limited'){throw 'Interactive launch task is not current-user/Limited.'}
if($installer -notmatch "MultipleInstancesPolicy = 'StopExisting'" -or $installer -notmatch "MultipleInstancesPolicy -ne 'StopExisting'"){throw 'QQ reconcile task must replace and verify a sleeping watcher for an interactive request.'}
if($scheduler -notmatch 'timeoutMs\s*=\s*40_000'){throw 'QQ interactive confirmation must finish before the 60-second plugin timeout.'}
if($installer -notmatch '(?s)if \(Test-Path -LiteralPath \$containerConfigPath -PathType Leaf\).*?Set-QQContainerConfigAcl \$containerConfigPath'){throw 'Existing container config is not re-sealed after an interrupted install.'}
if($worker -notmatch "'ManualRestore'\{Manual-Restore\}" -or $worker -notmatch "'ManualProtect'\{Manual-Protect\}" -or $worker -notmatch "'MaintenanceRestore'\{Maintenance-Restore\}"){throw 'Worker fixed maintenance modes are incomplete.'}
if($deploy -match 'qq-temporary-release\.ps1|Restore-QQTempExpiry\.ps1|verify-qq-temporary-release\.ps1'){throw 'Deployment still installs temporary-release scripts.'}
$focusRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\focus-lock')).Path
foreach($file in @('qq-temporary-release.ps1','Restore-QQTempExpiry.ps1','verify-qq-temporary-release.ps1')){
 if(Test-Path -LiteralPath (Join-Path $focusRoot $file)){throw "Temporary-release source still exists: $file"}
}
[ordered]@{ok=$true;systemTasks=3;interactiveLaunchLimited=$true;containerHelperDeployed=$true;temporaryReleaseRemoved=$true}|ConvertTo-Json -Compress
