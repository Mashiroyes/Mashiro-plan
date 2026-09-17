[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$root=Join-Path $env:TEMP ('mashiro-qq-worker-test-'+[guid]::NewGuid().ToString('N'))
$state=Join-Path $root 'state';$focus=Join-Path $root 'focus';$downloads=Join-Path $root 'Downloads'
$program=Join-Path $root 'QQProgram';$userData=Join-Path $root 'QQUserData';$hosts=Join-Path $root 'hosts';$db=Join-Path $root 'planner.sqlite'
$worker=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell\qq-session-worker-v1.ps1'
$helper=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell\qq-session-db-v1.mjs'
function Enc($v){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 10 -Compress)))}
function Db($cmd,$payload){$raw=& node $helper $cmd $db (Enc $payload);if($LASTEXITCODE-ne 0){throw "DB failed: $raw"};$raw|ConvertFrom-Json -DateKind String}
function Worker($mode,$at,$extra=@{}){
 $args=@('-NoProfile','-NonInteractive','-File',$worker,'-Mode',$mode,'-SqlitePath',$db,'-StateRoot',$state,'-FocusLockRoot',$focus,'-HostsPath',$hosts,'-Now',$at,'-FixtureMode','-SkipSignatureValidation','-FixtureInstallPath',$program,'-FixtureDownloadsPath',$downloads)
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
 if(-not(Db 'create64' @{id='fixture-one';requestedAt='2026-09-15T04:00:00Z';playMinutes=20;phase='preparing'}).created){throw 'First request was not created.'}
 $playing=Worker 'PrepareAndStart' '2026-09-15T04:01:00Z' @{SessionId='fixture-one'}
 if(-not $playing.authorizationActive-or $playing.clientBarrierActive-or-not $playing.websiteBlockActive-or-not $playing.qqInstalled){throw 'Playing invariant failed.'}
 if(Test-Path $setup){throw 'QQ installer was not deleted.'};if(-not(Test-Path (Join-Path $downloads 'epubor_ultimate_setup.exe'))){throw 'Unrelated installer was deleted.'}
 $cooldown=Worker 'Reconcile' '2026-09-15T04:21:00Z' @{SessionId='fixture-one'}
 if($cooldown.authorizationActive-or-not $cooldown.clientBarrierActive-or-not $cooldown.websiteBlockActive-or $cooldown.qqInstalled){throw 'Cooldown invariant failed.'}
 if(Test-Path $qq){throw 'QQ.exe was not protected at the end of play.'};if($cooldown.installedExecutableVault.state-ne'protected'){throw 'QQ.exe vault was not marked protected.'}
 if(-not(Test-Path (Join-Path $userData 'keep.txt'))){throw 'User data was removed.'}
 $ready=Worker 'Reconcile' '2026-09-15T05:51:00Z' @{SessionId='fixture-one'}
 if($ready.phase-ne'ready'-or $ready.qqInstalled-or $ready.installedExecutableVault.state-ne'protected'){throw 'Cooldown restored QQ.exe or did not finish.'}
 if(-not(Db 'create64' @{id='fixture-two';requestedAt='2026-09-15T06:00:00Z';playMinutes=20;phase='preparing'}).created){throw 'Second request was not created.'}
 $restored=Worker 'PrepareAndStart' '2026-09-15T06:01:00Z' @{SessionId='fixture-two'}
 if(-not $restored.qqInstalled-or $restored.installedExecutableVault.state-ne'available' -or -not(Test-Path $qq)){throw 'QQ.exe was not restored only for the next request.'}
 $protectedAgain=Worker 'Reconcile' '2026-09-15T06:21:00Z' @{SessionId='fixture-two'}
 if($protectedAgain.installedExecutableVault.state-ne'protected'){throw 'Second QQ.exe protection failed.'}
 Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') $qq
 $legacyReady=Worker 'Reconcile' '2026-09-15T07:51:00Z' @{SessionId='fixture-two'}
 if(-not(Db 'create64' @{id='fixture-conflict';requestedAt='2026-09-15T08:00:00Z';playMinutes=10;phase='preparing'}).created){throw 'Conflict request was not created.'}
 $conflicted=$false;try{Worker 'PrepareAndStart' '2026-09-15T08:01:00Z' @{SessionId='fixture-conflict'}|Out-Null}catch{$conflicted=$true}
 if(-not $conflicted){throw 'Occupied QQ.exe path did not block restoration.'};if(-not(Test-Path $qq)){throw 'Conflict file was overwritten or deleted.'}
 [ordered]@{ok=$true;playing=$playing;cooldown=$cooldown;ready=$ready;restored=$restored}|ConvertTo-Json -Depth 12 -Compress
}finally{if(Test-Path $root){Remove-Item -LiteralPath $root -Recurse -Force}}
