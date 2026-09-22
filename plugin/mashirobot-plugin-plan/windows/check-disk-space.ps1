param([switch]$DryRun,[string]$DriveFixtureJson='',[string]$Today='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'reminder-common.ps1')
function Get-Severity([int64]$Free){if($Free-lt 5GB){return 3};if($Free-lt 10GB){return 2};if($Free-lt 20GB){return 1};return 0}
function Get-PreviousDisk($State,[string]$Name){if($State-is[Collections.IDictionary]){return $State[$Name]};$property=$State.PSObject.Properties[$Name];if($property){return $property.Value};return $null}
try {
  $today=if($Today){$Today}else{(Get-Date).ToString('yyyy-MM-dd')}
  $previous=Get-PlanPluginState -StateKey 'disk-space:severity-v1'
  if(-not $previous){$previous=@{}}
  $sourceDisks=if($DriveFixtureJson){@($DriveFixtureJson|ConvertFrom-Json)}else{@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')}
  $low=@($sourceDisks|Where-Object{$null-ne$_.FreeSpace-and$null-ne$_.Size}|ForEach-Object{[pscustomobject]@{DeviceID=$_.DeviceID;Free=[int64]$_.FreeSpace;Size=[int64]$_.Size;Severity=(Get-Severity ([int64]$_.FreeSpace))}}|Where-Object{$_.Severity-gt 0}|Sort-Object DeviceID)
  if($low.Count-eq 0){Set-PlanPluginState -StateKey 'disk-space:severity-v1' -State @{};Write-Output 'NO_REPLY';exit 0}
  $notify=@($low|Where-Object{$old=Get-PreviousDisk $previous ([string]$_.DeviceID);-not $old-or [string]$old.date-ne$today-or [int]$old.severity-lt$_.Severity})
  if($notify.Count-eq 0){Write-Output 'NO_REPLY';exit 0}
  $state=@{}
  foreach($disk in $low){$state[$disk.DeviceID]=@{date=$today;severity=$disk.Severity}}
  Set-PlanPluginState -StateKey 'disk-space:severity-v1' -State $state
  $max=($notify|Measure-Object Severity -Maximum).Maximum
  $label=@{1='普通';2='严重';3='紧急'}[[int]$max]
  $details=@($notify|ForEach-Object{$f=[math]::Round($_.Free/1GB,1);$t=[math]::Round($_.Size/1GB,1);$p=[math]::Round(100.0*$_.Free/$_.Size,1);"- $($_.DeviceID) $f GB / $t GB 可用（$p%）"})
  $message=@("⚠️ 磁盘空间$label")+$details+@('请及时清理或迁移文件。')
  $priority=if([int]$max-eq 3){2}else{5}
  Send-ManagedReminder -Message ($message-join[Environment]::NewLine) -Kind 'disk' -Priority $priority -DedupeKey ("disk:${today}:${max}:"+($notify.DeviceID-join',')) -SourceRef ($notify.DeviceID-join',') -DryRun:$DryRun|Out-Null
  Write-Output 'NO_REPLY'
}catch{[Console]::Error.WriteLine("磁盘空间检查失败：$($_.Exception.Message)");exit 1}
