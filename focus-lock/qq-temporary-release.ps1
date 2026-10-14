[CmdletBinding()]param([ValidateRange(1,1440)][int]$Minutes=10)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$focusRoot=Join-Path $env:ProgramData 'CodexFocusLock'
$qqRoot=Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq'
$statePath=Join-Path $focusRoot 'bilibili-qq-expiry.json'
$statusPath=Join-Path $qqRoot 'last-status.json'
$authorizationPath=Join-Path $focusRoot 'qq-play-authorization.json'
$restoreScript=Join-Path $focusRoot 'Restore-QQTempExpiry.ps1'
$resultPath=Join-Path $focusRoot 'qq-temp-release-result.json'
$expiresAt=[DateTimeOffset]::Now.AddMinutes($Minutes)
$startedAt=Get-Date

Disable-ScheduledTask -TaskName 'MashiroBot-QQSession-Reconcile' -ErrorAction SilentlyContinue|Out-Null
$state=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json
$state|Add-Member -NotePropertyName QQReleased -NotePropertyValue $true -Force
$state|Add-Member -NotePropertyName QQReleaseUntil -NotePropertyValue $expiresAt.ToString('o') -Force
$state|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $statePath -Encoding UTF8
[ordered]@{SessionId='manual-temporary-release';QQInstallUntil=$expiresAt.ToUniversalTime().ToString('o');QQPlayUntil=$expiresAt.ToUniversalTime().ToString('o');UpdatedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $authorizationPath -Encoding UTF8

& (Join-Path $focusRoot 'FocusLock.ps1') -Mode Reapply|Out-Null
Start-ScheduledTask -TaskName 'MashiroBot-QQSession-ManualRestore' -ErrorAction Stop
$deadline=(Get-Date).AddSeconds(90);$verified=$null
do{
 Start-Sleep -Milliseconds 200
 if((Test-Path -LiteralPath $statusPath -PathType Leaf) -and (Get-Item -LiteralPath $statusPath).LastWriteTime -ge $startedAt){
  $candidate=Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8|ConvertFrom-Json -DateKind String
  if($candidate.ok -and $candidate.qqInstalled -and [string]$candidate.installedExecutableVault.state -eq 'available' -and -not$candidate.installedExecutableVault.PSObject.Properties['vaultPath']){$verified=$candidate}
 }
}while(-not$verified -and (Get-Date)-lt$deadline)
if(-not$verified){throw 'QQ SYSTEM restore did not produce a verified executable.'}
$qqPath=@($verified.qqExecutablePaths)|Select-Object -First 1
if(-not$qqPath-or-not(Test-Path -LiteralPath $qqPath -PathType Leaf)){throw 'Restored QQ executable path is missing.'}
$hash=(Get-FileHash -LiteralPath $qqPath -Algorithm SHA256).Hash
if($hash-ne[string]$verified.installedExecutableVault.sha256){throw 'Restored QQ executable hash mismatch.'}
$signature=Get-AuthenticodeSignature -LiteralPath $qqPath
if($signature.Status-ne'Valid'-or[string]$signature.SignerCertificate.Subject-notmatch'(?i)Tencent'){throw 'Restored QQ executable signature is invalid.'}

$action=New-ScheduledTaskAction -Execute (Get-Command pwsh.exe -ErrorAction Stop).Source -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $restoreScript)
$trigger=New-ScheduledTaskTrigger -Once -At $expiresAt.LocalDateTime
$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'CodexFocusLock-QQTempExpiry' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force|Out-Null
[ordered]@{Status='Released';ExpiresAt=$expiresAt.ToString('o');Minutes=$Minutes;QQExecutableHash=$hash;VaultState='available';PublicStatusLeaksVaultPath=$false}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $resultPath -Encoding UTF8

