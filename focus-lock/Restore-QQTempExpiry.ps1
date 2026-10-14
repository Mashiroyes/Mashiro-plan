$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$root=Join-Path $env:ProgramData 'CodexFocusLock';$qqRoot=Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq'
$statePath=Join-Path $root 'bilibili-qq-expiry.json';$authorizationPath=Join-Path $root 'qq-play-authorization.json';$statusPath=Join-Path $qqRoot 'last-status.json'
$state=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json
$state|Add-Member -NotePropertyName QQReleased -NotePropertyValue $false -Force
$state|Add-Member -NotePropertyName QQReleaseUntil -NotePropertyValue $null -Force
$state|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $statePath -Encoding UTF8
[ordered]@{SessionId=$null;QQInstallUntil=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');QQPlayUntil=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');UpdatedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $authorizationPath -Encoding UTF8
& (Join-Path $root 'FocusLock.ps1') -Mode Reapply|Out-Null
$startedAt=Get-Date;Start-ScheduledTask -TaskName 'MashiroBot-QQSession-ManualProtect' -ErrorAction Stop
$deadline=(Get-Date).AddSeconds(90);$protected=$false
do{
 Start-Sleep -Milliseconds 200
 if((Test-Path -LiteralPath $statusPath -PathType Leaf) -and (Get-Item -LiteralPath $statusPath).LastWriteTime -ge $startedAt){
  $status=Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8|ConvertFrom-Json -DateKind String
  $protected=[bool]($status.ok -and -not$status.qqInstalled -and [string]$status.installedExecutableVault.state -eq 'protected' -and [int]$status.installedExecutableVault.formatVersion -eq 2 -and -not$status.installedExecutableVault.PSObject.Properties['vaultPath'])
 }
}while(-not$protected -and (Get-Date)-lt$deadline)
if(-not$protected){throw 'QQ SYSTEM protection did not verify encrypted state.'}
Enable-ScheduledTask -TaskName 'MashiroBot-QQSession-Reconcile' -ErrorAction Stop|Out-Null
Start-ScheduledTask -TaskName 'MashiroBot-QQSession-Reconcile' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'CodexFocusLock-QQTempExpiry' -Confirm:$false -ErrorAction SilentlyContinue

