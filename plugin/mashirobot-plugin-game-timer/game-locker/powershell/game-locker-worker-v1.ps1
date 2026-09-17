[CmdletBinding()]
param(
 [ValidateSet('Reconcile','Status')][string]$Mode='Reconcile',
 [Parameter(Mandatory=$true)][string]$SqlitePath,
 [string]$StateRoot=(Join-Path $env:ProgramData 'MashiroBot\game-locker'),
 [string]$Now,[switch]$FixtureMode
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$OutputEncoding
$helper=Join-Path $PSScriptRoot 'game-locker-db-v1.mjs';$vaultRoot=Join-Path $StateRoot 'vault'
$clock=if($Now){[DateTimeOffset]::Parse($Now).ToUniversalTime()}else{[DateTimeOffset]::UtcNow}
$taskPrefix='MashiroBot-GameLocker-Restore-';$mainTask='MashiroBot-GameLocker-Reconcile'
function B64($v){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 10 -Compress)))}
function Db($command,$payload=$null){$args=@($helper,$command,$SqlitePath);if($null-ne$payload){$args+=B64 $payload};$raw=& node @args 2>&1;if($LASTEXITCODE-ne 0){throw($raw-join[Environment]::NewLine)};if($raw){($raw-join'')|ConvertFrom-Json -DateKind String}}
function Update($row,$values){$values.updated_at=$clock.ToString('o');[void](Db 'update64' @{id=$row.id;values=$values})}
function Log($message){$dir=Join-Path $StateRoot 'logs';New-Item -ItemType Directory -Path $dir -Force|Out-Null;[IO.File]::AppendAllText((Join-Path $dir 'game-locker.log'),("{0} {1}`r`n"-f[DateTimeOffset]::Now.ToString('o'),$message),[Text.UTF8Encoding]::new($false))}
function Notify($message){if($FixtureMode){return};try{& 'D:\Program\nodejs\npm_global24\openclaw.ps1' message send --json --channel openclaw-weixin --account 'ea8fd13b2100-im-bot' --target 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat' --message $message|Out-Null}catch{Log("notify failed: $($_.Exception.Message)")}}
function Exact-ProcessExists($path){$full=[IO.Path]::GetFullPath($path);@((Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)|Where-Object{$_.ExecutablePath-and[string]::Equals([IO.Path]::GetFullPath([string]$_.ExecutablePath),$full,[StringComparison]::OrdinalIgnoreCase)}).Count-gt 0}
function Valid-Source($path){if([IO.Path]::GetExtension($path) -ine '.exe'){throw 'Only .exe files can be protected.'};$item=Get-Item -LiteralPath $path -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse points are not allowed.'};if(Exact-ProcessExists $path){throw 'Target executable is still running.'};$item}
function Register-Restore($row,$due){
 if($FixtureMode){return};$name=$taskPrefix+$row.id;$pwsh=(Get-Command pwsh.exe).Source
 $args='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode Reconcile -SqlitePath "{1}" -StateRoot "{2}"'-f$PSCommandPath,$SqlitePath,$StateRoot
 $action=New-ScheduledTaskAction -Execute $pwsh -Argument $args;$trigger=New-ScheduledTaskTrigger -Once -At $due.LocalDateTime
 $principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
 $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
 Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force|Out-Null
 $name
}
function Protect($row){
 $source=[string]$row.original_path;$dest=$null;$hash=$null;$failureRecorded=$false
 try{
  if(-not(Test-Path -LiteralPath $source -PathType Leaf)){Update $row @{state='missing';error='Configured executable is missing.'};return}
  [void](Valid-Source $source);$hash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  $folder=Join-Path $vaultRoot ([guid]::NewGuid().ToString('N'));$dest=Join-Path $folder (([guid]::NewGuid().ToString('N'))+'.bin')
  New-Item -ItemType Directory -Path $folder -Force|Out-Null;Update $row @{state='preparing';vault_path=$dest;sha256=$hash;error=$null}
  Move-Item -LiteralPath $source -Destination $dest
  $protected=$clock;$due=$protected.AddHours(2)
  Update $row @{state='quarantined';protected_at=$protected.ToString('o');restore_due_at=$due.ToString('o');error=$null}
  try{$task=Register-Restore $row $due;Update $row @{restore_task_name=$task;error=$null}}
  catch{
   $registrationError=$_.Exception.Message
   if((Test-Path -LiteralPath $dest -PathType Leaf)-and-not(Test-Path -LiteralPath $source)){
    Move-Item -LiteralPath $dest -Destination $source
    Update $row @{state='failed';restored_at=$clock.ToString('o');error="Restore task registration failed; executable was rolled back: $registrationError"}
    $failureRecorded=$true
   }else{Update $row @{state='quarantined';error="Restore task registration failed; startup/logon recovery remains available: $registrationError"};$failureRecorded=$true}
   throw
  }
  Notify("游戏 $($row.display_name) 已进入保护，预计 $($due.ToLocalTime().ToString('yyyy/M/d HH:mm:ss')) 恢复。")
 }catch{
  $message=$_.Exception.Message
  if($dest-and(Test-Path -LiteralPath $dest -PathType Leaf)-and-not(Test-Path -LiteralPath $source)){
   $actual=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
   if($hash-and$actual-eq$hash){
    $due=$clock.AddHours(2);Update $row @{state='quarantined';protected_at=$clock.ToString('o');restore_due_at=$due.ToString('o');error="Protection completed but restore scheduling needs recovery: $message"}
   }else{Update $row @{state='invalid';error="Protection failed and vault verification failed: $message"}}
  }elseif(-not$failureRecorded){Update $row @{state='failed';error=$message}}
  Log("protect $($row.id) failed: $message");Notify("游戏 $($row.display_name) 保护失败：$message")
 }
}
function Recover-Preparing($row){
 $source=[string]$row.original_path;$dest=[string]$row.vault_path
 if($dest-and(Test-Path -LiteralPath $dest -PathType Leaf)-and-not(Test-Path -LiteralPath $source)){
  $actual=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash;if($actual-ne[string]$row.sha256){Update $row @{state='invalid';error='Vault hash mismatch during recovery.'};return}
  $due=$clock.AddHours(2);$task=Register-Restore $row $due;Update $row @{state='quarantined';protected_at=$clock.ToString('o');restore_due_at=$due.ToString('o');restore_task_name=$task;error=$null};return
 }
 if(Test-Path -LiteralPath $source -PathType Leaf){Protect $row}else{Update $row @{state='missing';error='Neither source nor vault file exists.'}}
}
function Restore($row){
 try{
  $dest=[string]$row.vault_path;if(-not(Test-Path -LiteralPath $dest -PathType Leaf)){Update $row @{state='missing';error='Protected file is missing.'};return}
  $actual=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash;if($actual-ne[string]$row.sha256){Update $row @{state='invalid';error='Protected file hash mismatch.'};Notify("游戏 $($row.display_name) 文件校验失败，未恢复。");return}
  $source=[string]$row.original_path;if(Test-Path -LiteralPath $source){$firstConflict=([string]$row.state-ne'restore_conflict');Update $row @{state='restore_conflict';error='Original path is occupied.'};if($firstConflict){Notify("游戏 $($row.display_name) 恢复冲突：原路径已有文件，保护文件仍保留。")};return}
  New-Item -ItemType Directory -Path (Split-Path -Parent $source)-Force|Out-Null;Move-Item -LiteralPath $dest -Destination $source
  Update $row @{state='restored';restored_at=$clock.ToString('o');error=$null};if($row.restore_task_name-and-not$FixtureMode){Unregister-ScheduledTask -TaskName ([string]$row.restore_task_name)-Confirm:$false-ErrorAction SilentlyContinue}
  $folder=Split-Path -Parent $dest
  try { if((Test-Path -LiteralPath $folder) -and (@(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0)){Remove-Item -LiteralPath $folder -Force} } catch { Log("empty vault folder cleanup skipped: $($_.Exception.Message)") }
  Notify("游戏 $($row.display_name) 的 EXE 已恢复。")
 }catch{Update $row @{state='failed';error=$_.Exception.Message};Log("restore $($row.id) failed: $($_.Exception.Message)");Notify("游戏 $($row.display_name) 恢复失败：$($_.Exception.Message)")}
}
function Reconcile {foreach($row in @(Db 'open')){if($row.state-eq'pending'){Protect $row}elseif($row.state-eq'preparing'){Recover-Preparing $row}elseif($row.state-eq'quarantined'-and$row.restore_due_at-and$clock-ge[DateTimeOffset]::Parse([string]$row.restore_due_at).ToUniversalTime()){Restore $row}elseif($row.state-eq'restore_conflict'-and-not(Test-Path -LiteralPath ([string]$row.original_path))){Restore $row}}}
if($Mode-eq'Reconcile'){Reconcile};$counts=@(Db 'status');[ordered]@{ok=$true;counts=$counts;workerProcessPersistent=$false;currentTime=$clock.ToString('o')}|ConvertTo-Json -Depth 6 -Compress
