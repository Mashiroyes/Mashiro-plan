[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$root=Join-Path $env:TEMP ('mashiro-qq-worker-test-'+[guid]::NewGuid().ToString('N'))
$state=Join-Path $root 'state';$focus=Join-Path $root 'focus';$downloads=Join-Path $root 'Downloads'
$program=Join-Path $root 'QQProgram';$userData=Join-Path $root 'QQUserData';$hosts=Join-Path $root 'hosts';$db=Join-Path $root 'planner.sqlite'
$worker=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell\qq-session-worker-v1.ps1'
$helper=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell\qq-session-db-v1.mjs'
$workerText=Get-Content -LiteralPath $worker -Raw -Encoding UTF8
if($workerText-notmatch '\[Math\]::Min\(60,'){throw 'Watch mode must refresh its status heartbeat at least once per minute during long sessions.'}
if($workerText-notmatch 'function Submit-TimeoutReading'){throw 'QQ timeout must submit the reading prompt after the client barrier is restored.'}
if($workerText-notmatch 'qq:\{0\}:\{1\}'){throw 'QQ timeout reading events must be session-specific.'}
if($workerText-notmatch '&\s+\$timeoutPrompt\s+-Mode\s+Submit\s+-EventKey\s+\$eventKey'){throw 'QQ timeout prompt must invoke named PowerShell parameters directly.'}
if($workerText-match '\$local\.DayOfWeek\s*-eq\s*\[DayOfWeek\]::Sunday'){throw 'Daily QQ sessions must not be restricted to Sunday.'}
function Enc($v){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 10 -Compress)))}
function Db($cmd,$payload){$raw=& node $helper $cmd $db (Enc $payload);if($LASTEXITCODE-ne 0){throw "DB failed: $raw"};$raw|ConvertFrom-Json -DateKind String}
function Worker($mode,$at,$extra=@{}){
 $args=@('-NoProfile','-NonInteractive','-File',$worker,'-Mode',$mode,'-SqlitePath',$db,'-StateRoot',$state,'-ExecutableContainerRoot',(Join-Path $state 'objects'),'-FocusLockRoot',$focus,'-HostsPath',$hosts,'-Now',$at,'-FixtureMode','-SkipSignatureValidation','-FixtureInstallPath',$program,'-FixtureDownloadsPath',$downloads)
 foreach($key in $extra.Keys){$args+='-'+$key;$args+=[string]$extra[$key]}
 $raw=& pwsh @args 2>&1;if($LASTEXITCODE-ne 0){throw "Worker failed: $raw"};$raw|ConvertFrom-Json -DateKind String
}
try{
 New-Item -ItemType Directory -Path $downloads,$userData,$focus,$program -Force|Out-Null
 ($domains=@('im.qq.com','pc.qq.com','dldir.qq.com','dldir1.qq.com','dldir1v6.qq.com','download.imqq.com'))|ForEach-Object{"0.0.0.0 $_"}|Set-Content -LiteralPath $hosts -Encoding UTF8
 Set-Content -LiteralPath (Join-Path $userData 'keep.txt') -Value preserve
 Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') (Join-Path $downloads 'epubor_ultimate_setup.exe')
 $setup=Join-Path $downloads 'QQSetup.exe';Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') $setup
 $qq=Join-Path $program 'QQ.exe';Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') $qq
 if(-not(Db 'create64' @{id='fixture-one';requestedAt='2026-09-20T04:00:00Z';playMinutes=20;phase='preparing'}).created){throw 'First request was not created.'}
 $playing=Worker 'PrepareAndStart' '2026-09-20T04:01:00Z' @{SessionId='fixture-one'}
 if(-not $playing.authorizationActive-or $playing.clientBarrierActive-or-not $playing.websiteBlockActive-or-not $playing.qqInstalled){throw 'Playing invariant failed.'}
 if(Test-Path $setup){throw 'QQ installer was not deleted.'};if(-not(Test-Path (Join-Path $downloads 'epubor_ultimate_setup.exe'))){throw 'Unrelated installer was deleted.'}
 $cooldown=Worker 'Reconcile' '2026-09-20T04:21:00Z' @{SessionId='fixture-one'}
 if($cooldown.authorizationActive-or-not $cooldown.clientBarrierActive-or-not $cooldown.websiteBlockActive-or $cooldown.qqInstalled){throw 'Cooldown invariant failed.'}
 if(Test-Path $qq){throw 'QQ.exe was not protected at the end of play.'};if($cooldown.installedExecutableVault.state-ne'protected'){throw 'QQ.exe vault was not marked protected.'}
 if($cooldown.installedExecutableVault.PSObject.Properties['vaultPath']){throw 'Public QQ status leaked vaultPath.'}
 $protectedRecord=Db 'installed-vault-active-internal' @{}
 if($protectedRecord.formatVersion-ne 2){throw 'QQ executable was not stored in encrypted format version 2.'}
 $containerHead=[IO.File]::ReadAllBytes([string]$protectedRecord.vaultPath)[0..1]
 if([Convert]::ToHexString($containerHead)-eq'MZ'){throw 'Protected QQ payload retained a PE header.'}
 if(-not(Test-Path (Join-Path $userData 'keep.txt'))){throw 'User data was removed.'}
 $ready=Worker 'Reconcile' '2026-09-20T06:22:00Z' @{SessionId='fixture-one'}
 if($ready.phase-ne'ready'-or $ready.qqInstalled-or $ready.installedExecutableVault.state-ne'protected'){throw 'Cooldown restored QQ.exe or did not finish.'}
 if(-not(Db 'create64' @{id='fixture-after-close';requestedAt='2026-09-20T14:00:00Z';playMinutes=1;phase='preparing'}).created){throw '22:00 request was not created.'}
 $afterCloseRejected=$false;try{Worker 'PrepareAndStart' '2026-09-20T14:00:00Z' @{SessionId='fixture-after-close'}|Out-Null}catch{if($_.Exception.Message-match 'daily from 12:00 through 22:00'){$afterCloseRejected=$true}}
 if(-not $afterCloseRejected){throw 'QQ worker accepted a 22:00 session.'}
 $afterCloseStatus=Worker 'Status' '2026-09-20T14:00:00Z' @{SessionId='fixture-after-close'}
 if($afterCloseStatus.authorizationActive-or-not $afterCloseStatus.clientBarrierActive){throw 'After-close rejection released the QQ client barrier.'}
 if(-not(Db 'create64' @{id='fixture-two';requestedAt='2026-09-20T06:30:00Z';playMinutes=20;phase='preparing'}).created){throw 'Second request was not created.'}
 $restored=Worker 'PrepareAndStart' '2026-09-20T06:31:00Z' @{SessionId='fixture-two'}
 if(-not $restored.qqInstalled-or $restored.installedExecutableVault.state-ne'available' -or -not(Test-Path $qq)){throw 'QQ.exe was not restored only for the next request.'}
 $protectedAgain=Worker 'Reconcile' '2026-09-20T06:51:00Z' @{SessionId='fixture-two'}
 if($protectedAgain.installedExecutableVault.state-ne'protected'){throw 'Second QQ.exe protection failed.'}
 Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') $qq
 $legacyReady=Worker 'Reconcile' '2026-09-20T08:52:00Z' @{SessionId='fixture-two'}
 [void](Db 'installed-vault-update64' @{state='invalid';error='simulated stale conflict';updatedAt='2026-09-20T08:52:30Z'})
 $repairedDuplicate=Worker 'Recover' '2026-09-20T08:53:00Z'
 if($repairedDuplicate.installedExecutableVault.state-ne'available'){throw 'Recover did not accept an identical regenerated QQ.exe.'}
 if(-not(Db 'create64' @{id='fixture-duplicate';requestedAt='2026-09-20T09:00:00Z';playMinutes=10;phase='preparing'}).created){throw 'Duplicate recovery request was not created.'}
 $duplicateRecovered=Worker 'PrepareAndStart' '2026-09-20T09:01:00Z' @{SessionId='fixture-duplicate'}
 if($duplicateRecovered.phase-ne'playing'-or-not $duplicateRecovered.authorizationActive){throw 'An identical regenerated QQ.exe was not accepted.'}
 [void](Worker 'Reconcile' '2026-09-20T09:11:00Z' @{SessionId='fixture-duplicate'})
 [void](Worker 'Reconcile' '2026-09-20T10:32:00Z' @{SessionId='fixture-duplicate'})
 Set-Content -LiteralPath $qq -Value 'different occupied file' -Encoding UTF8
 if(-not(Db 'create64' @{id='fixture-conflict';requestedAt='2026-09-20T10:33:00Z';playMinutes=10;phase='preparing'}).created){throw 'Conflict request was not created.'}
 $conflicted=$false;try{Worker 'PrepareAndStart' '2026-09-20T10:34:00Z' @{SessionId='fixture-conflict'}|Out-Null}catch{$conflicted=$true}
 if(-not $conflicted){throw 'Occupied QQ.exe path did not block restoration.'};if(-not(Test-Path $qq)){throw 'Conflict file was overwritten or deleted.'}
 $boundaryRoot=Join-Path $root 'boundary';$state=Join-Path $boundaryRoot 'state';$focus=Join-Path $boundaryRoot 'focus';$downloads=Join-Path $boundaryRoot 'Downloads'
 $program=Join-Path $boundaryRoot 'QQProgram';$userData=Join-Path $boundaryRoot 'QQUserData';$hosts=Join-Path $boundaryRoot 'hosts';$db=Join-Path $boundaryRoot 'planner.sqlite'
 New-Item -ItemType Directory -Path $downloads,$userData,$focus,$program -Force|Out-Null
 $domains|ForEach-Object{"0.0.0.0 $_"}|Set-Content -LiteralPath $hosts -Encoding UTF8
 $qq=Join-Path $program 'QQ.exe';Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') $qq
 if(-not(Db 'create64' @{id='fixture-before-close';requestedAt='2026-09-20T13:09:28Z';playMinutes=50;phase='preparing'}).created){throw 'Near-close request was not created.'}
 $beforeClosePlaying=Worker 'PrepareAndStart' '2026-09-20T13:09:28Z' @{SessionId='fixture-before-close'}
 if($beforeClosePlaying.phase-ne'playing'-or-not $beforeClosePlaying.authorizationActive){throw 'Near-close request did not start.'}
 $beforeCloseStillPlaying=Worker 'Reconcile' '2026-09-20T13:10:34Z' @{SessionId='fixture-before-close'}
 if($beforeCloseStillPlaying.phase-ne'playing'-or-not $beforeCloseStillPlaying.authorizationActive-or-not $beforeCloseStillPlaying.qqInstalled){throw 'A valid near-close session was ended early during reconciliation.'}
 $beforeCloseCooldown=Worker 'Reconcile' '2026-09-20T13:59:28Z' @{SessionId='fixture-before-close'}
 if($beforeCloseCooldown.phase-ne'cooldown'-or $beforeCloseCooldown.authorizationActive-or $beforeCloseCooldown.qqInstalled){throw 'Near-close session did not end at its actual deadline.'}
 if(-not(Db 'create64' @{id='fixture-weekday';requestedAt='2026-09-26T04:00:00Z';playMinutes=10;phase='preparing'}).created){throw 'Saturday request was not created.'}
 $weekdayPlaying=Worker 'PrepareAndStart' '2026-09-26T04:00:00Z' @{SessionId='fixture-weekday'}
 if($weekdayPlaying.phase-ne'playing'-or-not $weekdayPlaying.authorizationActive){throw 'QQ worker rejected a valid Saturday session.'}
 [void](Worker 'Reconcile' '2026-09-26T04:10:00Z' @{SessionId='fixture-weekday'})
 if(-not(Db 'create64' @{id='fixture-over-close';requestedAt='2026-09-27T13:30:00Z';playMinutes=50;phase='preparing'}).created){throw 'Over-close request was not created.'}
 $overCloseRejected=$false;try{Worker 'PrepareAndStart' '2026-09-27T13:30:00Z' @{SessionId='fixture-over-close'}|Out-Null}catch{if($_.Exception.Message-match 'daily from 12:00 through 22:00'){$overCloseRejected=$true}}
 if(-not $overCloseRejected){throw 'QQ worker accepted a session whose deadline exceeded 22:00.'}

 $sundayRoot=Join-Path $root 'sunday';$state=Join-Path $sundayRoot 'state';$focus=Join-Path $sundayRoot 'focus';$downloads=Join-Path $sundayRoot 'Downloads'
 $program=Join-Path $sundayRoot 'QQProgram';$userData=Join-Path $sundayRoot 'QQUserData';$hosts=Join-Path $sundayRoot 'hosts';$db=Join-Path $sundayRoot 'planner.sqlite'
 New-Item -ItemType Directory -Path $downloads,$userData,$focus,$program -Force|Out-Null
 $domains|ForEach-Object{"0.0.0.0 $_"}|Set-Content -LiteralPath $hosts -Encoding UTF8
 $qq=Join-Path $program 'QQ.exe';Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') $qq
 if(-not(Db 'create64' @{id='fixture-sunday-four';requestedAt='2026-10-11T13:00:00Z';playMinutes=180;windowPolicy='sunday-4h';specialLocalDate='2026-10-11';phase='preparing'}).created){throw 'Sunday truncated request was not created.'}
 $sundayPlaying=Worker 'PrepareAndStart' '2026-10-11T13:00:00Z' @{SessionId='fixture-sunday-four'}
 if($sundayPlaying.phase-ne'playing'-or$sundayPlaying.session.playEndsAt-ne'2026-10-11T16:00:00.000Z'-or-not$sundayPlaying.session.specialConsumedAt){throw 'Sunday truncated request did not start or consume its allowance.'}
 $beforeMidnight=Worker 'Reconcile' '2026-10-11T15:59:00Z' @{SessionId='fixture-sunday-four'}
 if($beforeMidnight.phase-ne'playing'-or-not$beforeMidnight.authorizationActive-or-not$beforeMidnight.qqInstalled){throw 'Sunday truncated request ended before midnight.'}
 $sundayCooldown=Worker 'Reconcile' '2026-10-11T16:00:00Z' @{SessionId='fixture-sunday-four'}
 if($sundayCooldown.phase-ne'cooldown'-or$sundayCooldown.qqInstalled-or$sundayCooldown.installedExecutableVault.formatVersion-ne 2){throw 'Sunday session did not encrypt QQ at midnight.'}
 [void](Worker 'Reconcile' '2026-10-11T17:00:00Z' @{SessionId='fixture-sunday-four'})
 $secondSunday=Db 'create64' @{id='fixture-sunday-second';requestedAt='2026-10-11T13:02:00Z';playMinutes=240;windowPolicy='sunday-4h';specialLocalDate='2026-10-11';phase='preparing'}
 if($secondSunday.created-or$secondSunday.reason-ne'sunday-limit'){throw 'A second Sunday four-hour request was not rejected.'}
 if(-not(Db 'create64' @{id='fixture-monday-four';requestedAt='2026-10-11T16:00:00Z';playMinutes=240;windowPolicy='sunday-4h';specialLocalDate='2026-10-12';phase='preparing'}).created){throw 'Monday rejection fixture was not created.'}
 $mondayRejected=$false;try{Worker 'PrepareAndStart' '2026-10-11T16:00:00Z' @{SessionId='fixture-monday-four'}|Out-Null}catch{if($_.Exception.Message-match 'Sunday QQ session policy is invalid'){$mondayRejected=$true}}
 if(-not$mondayRejected){throw 'Worker accepted the Sunday command on Monday.'}
 [ordered]@{ok=$true;playing=$playing;cooldown=$cooldown;ready=$ready;restored=$restored}|ConvertTo-Json -Depth 12 -Compress
}finally{if(Test-Path $root){Remove-Item -LiteralPath $root -Recurse -Force}}
