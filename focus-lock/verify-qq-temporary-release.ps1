$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$focusRoot=Join-Path $env:ProgramData 'CodexFocusLock';$qqRoot=Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq'
$expiry=Get-ScheduledTask -TaskName 'CodexFocusLock-QQTempExpiry' -ErrorAction SilentlyContinue
$reconcile=Get-ScheduledTask -TaskName 'MashiroBot-QQSession-Reconcile' -ErrorAction Stop
$restore=Get-ScheduledTask -TaskName 'MashiroBot-QQSession-ManualRestore' -ErrorAction Stop
$protect=Get-ScheduledTask -TaskName 'MashiroBot-QQSession-ManualProtect' -ErrorAction Stop
$authorization=Get-Content -LiteralPath (Join-Path $focusRoot 'qq-play-authorization.json') -Raw|ConvertFrom-Json -DateKind String
$status=Get-Content -LiteralPath (Join-Path $qqRoot 'last-status.json') -Raw|ConvertFrom-Json -DateKind String
$processes=@(Get-Process -Name QQ -ErrorAction SilentlyContinue)
[ordered]@{
 ExpiryTaskExists=[bool]$expiry
 ExpiryTaskUser=if($expiry){[string]$expiry.Principal.UserId}else{$null}
 ExpiryTaskRunLevel=if($expiry){[string]$expiry.Principal.RunLevel}else{$null}
 ReconcileState=[string]$reconcile.State
 ManualRestoreUser=[string]$restore.Principal.UserId
 ManualProtectUser=[string]$protect.Principal.UserId
 AuthorizationSessionId=[string]$authorization.SessionId
 AuthorizationUntil=[string]$authorization.QQPlayUntil
 Phase=[string]$status.phase
 QQInstalled=[bool]$status.qqInstalled
 VaultState=[string]$status.installedExecutableVault.state
 VaultFormatVersion=[int]$status.installedExecutableVault.formatVersion
 PublicStatusLeaksVaultPath=[bool]$status.installedExecutableVault.PSObject.Properties['vaultPath']
 ClientBarrierActive=[bool]$status.clientBarrierActive
 WebsiteBlockActive=[bool]$status.websiteBlockActive
 QQProcessCount=$processes.Count
}|ConvertTo-Json -Depth 6
