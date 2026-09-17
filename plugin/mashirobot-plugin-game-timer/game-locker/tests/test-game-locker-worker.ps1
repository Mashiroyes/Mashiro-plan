[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$root=Join-Path $env:TEMP ('game-locker-test-'+[guid]::NewGuid().ToString('N'));$db=Join-Path $root 'test.sqlite';$state=Join-Path $root 'state';$game=Join-Path $root 'game';$exe=Join-Path $game 'sample.exe'
$worker=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell\game-locker-worker-v1.ps1';$helper=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell\game-locker-db-v1.mjs'
function Enc($v){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Compress)))}
function Db($cmd,$payload){& node $helper $cmd $db (Enc $payload)|ConvertFrom-Json -DateKind String}
function Run($at){& pwsh -NoProfile -NonInteractive -File $worker -Mode Reconcile -SqlitePath $db -StateRoot $state -Now $at -FixtureMode|ConvertFrom-Json}
try{
 New-Item -ItemType Directory -Path $game -Force|Out-Null;Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') $exe
 $row=Db 'queue64' @{taskId='task-1';gameKey='game-1';displayName='Sample';originalPath=$exe;requestedAt='2026-09-15T04:00:00Z'}
 Run '2026-09-15T04:00:00Z'|Out-Null;$row=Db 'get' @{id=$row.id};if($row.state-ne'quarantined'-or(Test-Path $exe)-or-not(Test-Path $row.vault_path)){throw 'Protection failed.'};if($row.restore_due_at-ne'2026-09-15T06:00:00.0000000+00:00'-and$row.restore_due_at-ne'2026-09-15T06:00:00.000Z'){throw 'Wrong restore deadline.'}
 Run '2026-09-15T05:59:59Z'|Out-Null;if(Test-Path $exe){throw 'Restored early.'}
 Run '2026-09-15T06:00:00Z'|Out-Null;$row=Db 'get' @{id=$row.id};if($row.state-ne'restored'-or-not(Test-Path $exe)){throw "Restore failed: $($row|ConvertTo-Json -Compress)"}
 Run '2026-09-15T06:00:01Z'|Out-Null;if(-not(Test-Path $exe)){throw 'Replay changed terminal state.'}
 [ordered]@{ok=$true;state=$row.state}|ConvertTo-Json -Compress
}finally{if(Test-Path $root){Remove-Item -LiteralPath $root -Recurse -Force}}
