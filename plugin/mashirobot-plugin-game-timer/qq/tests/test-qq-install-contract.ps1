[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$powerShellRoot=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell'
$installer=Get-Content -LiteralPath (Join-Path $powerShellRoot 'install-qq-session.ps1') -Raw -Encoding UTF8
$worker=Get-Content -LiteralPath (Join-Path $powerShellRoot 'qq-session-worker-v1.ps1') -Raw -Encoding UTF8
$deploy=Get-Content -LiteralPath (Join-Path $powerShellRoot 'deploy-qq-session.ps1') -Raw -Encoding UTF8
foreach($required in @('MashiroBot-QQSession-ManualRestore','MashiroBot-QQSession-ManualProtect','MashiroBot-QQSession-MaintenanceRestore','qq-executable-container-v2.ps1','ContainerConfigPath')){
 if($installer-notmatch[regex]::Escape($required)){throw "Installer is missing required contract: $required"}
}
if($installer -notmatch "(?s)New-ScheduledTaskPrincipal\s+-UserId\s+'SYSTEM'.*?-RunLevel\s+Highest"){throw 'Vault-changing tasks are not based on SYSTEM/Highest principal.'}
if($installer -notmatch '(?s)LaunchInteractive.*?LogonType\s+Interactive.*?RunLevel\s+Limited'){throw 'Interactive launch task is not current-user/Limited.'}
if($installer -notmatch '(?s)if \(Test-Path -LiteralPath \$containerConfigPath -PathType Leaf\).*?Set-QQContainerConfigAcl \$containerConfigPath'){throw 'Existing container config is not re-sealed after an interrupted install.'}
if($worker -notmatch "'ManualRestore'\{Manual-Restore\}" -or $worker -notmatch "'ManualProtect'\{Manual-Protect\}" -or $worker -notmatch "'MaintenanceRestore'\{Maintenance-Restore\}"){throw 'Worker fixed maintenance modes are incomplete.'}
if($deploy -notmatch 'qq-temporary-release\.ps1' -or $deploy -notmatch 'Restore-QQTempExpiry\.ps1' -or $deploy -notmatch 'verify-qq-temporary-release\.ps1'){throw 'Deployment does not synchronize temporary-release scripts.'}
foreach($file in @('qq-temporary-release.ps1','Restore-QQTempExpiry.ps1','verify-qq-temporary-release.ps1')){
 $text=Get-Content -LiteralPath (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..\focus-lock')).Path $file) -Raw -Encoding UTF8
 if($text-match 'installedExecutableVault\.vaultPath|Copy-Item\s+-LiteralPath\s+\$vault'){throw "$file still copies a disclosed plaintext vault path."}
}
[ordered]@{ok=$true;systemTasks=3;interactiveLaunchLimited=$true;containerHelperDeployed=$true;temporaryReleaseUsesTasks=$true}|ConvertTo-Json -Compress
