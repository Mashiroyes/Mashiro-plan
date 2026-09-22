[CmdletBinding()]
param(
    [ValidateSet('Inspect','Apply')][string]$Mode='Inspect',
    [Parameter(Mandatory=$true)][string]$SqlitePath,
    [string]$NodePath='node.exe'
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$cli=Join-Path (Split-Path -Parent $PSScriptRoot) 'job-cli.mjs'
$recoverPayload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"olderThanMinutes":30}'))
$recoverRaw=& $NodePath $cli recover-stale $SqlitePath $recoverPayload 2>&1
if($LASTEXITCODE-ne 0){throw($recoverRaw-join[Environment]::NewLine)}
$recovered=[int](($recoverRaw-join'')|ConvertFrom-Json).recovered
$raw=& $NodePath $cli list $SqlitePath 2>&1
if($LASTEXITCODE-ne 0){throw($raw-join[Environment]::NewLine)}
$desired=@(($raw-join'')|ConvertFrom-Json)
$desiredByName=@{};foreach($job in $desired){$desiredByName[[string]$job.taskName]=$job}
$actual=@(Get-ScheduledTask -ErrorAction SilentlyContinue|Where-Object{
  ($_.TaskName-like'OpenClaw-*'-or$_.TaskName-like'MashiroBot*')-and(
    [string]$_.Actions.Arguments-match'(?i)-JobId\s'-or$desiredByName.ContainsKey([string]$_.TaskName)
  )
})
$actualByName=@{};foreach($task in $actual){$actualByName[[string]$task.TaskName]=$task}
$missing=@($desired|Where-Object{-not$actualByName.ContainsKey([string]$_.taskName)})
$orphaned=@($actual|Where-Object{-not$desiredByName.ContainsKey([string]$_.TaskName)})
$recreated=@();$removed=@();$failed=@()
if($Mode-eq'Apply'){
 foreach($task in $orphaned){try{Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false -ErrorAction Stop;$removed+=$task.TaskName}catch{$failed+=@{taskName=$task.TaskName;error=$_.Exception.Message}}}
 foreach($job in $missing){
  try{
   if($job.payload.reconcile){
    $reconcile=$job.payload.reconcile
    $invokeArgs=@($reconcile.argumentList|ForEach-Object{[string]$_})
    & ([string]$reconcile.executable) @invokeArgs|Out-Null
    if($LASTEXITCODE-ne 0){throw "Reconcile installer failed with exit code $LASTEXITCODE"}
    $recreated+=$job.taskName
    continue
   }
   $execution=$job.payload.execution;if(-not$execution){continue}
   $action=New-ScheduledTaskAction -Execute ([string]$execution.executable) -Argument ([string]$execution.arguments)
   if($job.recurrence-and$job.recurrence.intervalMinutes){$trigger=New-ScheduledTaskTrigger -Once -At ([DateTimeOffset]::Parse([string]$job.runAt).LocalDateTime) -RepetitionInterval (New-TimeSpan -Minutes ([int]$job.recurrence.intervalMinutes))}
   else{$trigger=New-ScheduledTaskTrigger -Once -At ([DateTimeOffset]::Parse([string]$job.runAt).LocalDateTime)}
   $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
   $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
   Register-ScheduledTask -TaskName ([string]$job.taskName) -InputObject (New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal) -Force|Out-Null
   $recreated+=$job.taskName
  }catch{$failed+=@{taskName=$job.taskName;error=$_.Exception.Message}}
 }
}
[ordered]@{ok=($failed.Count-eq 0);mode=$Mode;recoveredStale=$recovered;desired=$desired.Count;valid=@($desired|Where-Object{$actualByName.ContainsKey([string]$_.taskName)}).Count;missing=@($missing|ForEach-Object{$_.taskName});orphaned=@($orphaned|ForEach-Object{$_.TaskName});recreated=$recreated;removed=$removed;failed=$failed}|ConvertTo-Json -Depth 8 -Compress
