[CmdletBinding()]
param(
    [ValidateSet('Install','Inspect','Uninstall')][string]$Action='Inspect',
    [string]$SqlitePath,
    [string]$RuntimeBase=(Join-Path $env:LOCALAPPDATA 'MashiroBot\plan'),
    [switch]$DryRun
)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$OutputEncoding
$taskName='MashiroBot Plan Calendar Sync'
$sourcePlugin=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $RuntimeBase 'runtime-v1'
$runtimePlugin=Join-Path $runtime 'plugin'
if(-not $SqlitePath){$planRoot=Split-Path -Parent (Split-Path -Parent $sourcePlugin);$SqlitePath=Join-Path $planRoot 'sqlite\openclaw-planner.sqlite'}
$SqlitePath=[IO.Path]::GetFullPath($SqlitePath)

function Inspect-State {
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $worker=Join-Path $runtimePlugin 'windows\calendar-sync-worker.ps1'
    [pscustomobject]@{ok=([bool]$task-and(Test-Path -LiteralPath $worker));taskName=$taskName;taskExists=[bool]$task;runtime=$runtime;workerExists=(Test-Path -LiteralPath $worker);sqlitePath=$SqlitePath}
}
if($Action-eq'Inspect'){Inspect-State|ConvertTo-Json -Compress;exit 0}
if($Action-eq'Uninstall'){
    if(-not$DryRun){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue}
    [pscustomobject]@{ok=$true;removedTask=$taskName;runtimePreserved=$runtime}|ConvertTo-Json -Compress;exit 0
}
if(-not(Test-Path -LiteralPath $SqlitePath)){throw "Planner database not found: $SqlitePath"}
if(-not$DryRun){
    $staging=Join-Path $RuntimeBase ('staging-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $staging 'plugin') -Force|Out-Null
    foreach($directory in @('planner','windows','config')){
        $source=Join-Path $sourcePlugin $directory
        if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $staging 'plugin') -Recurse -Force}
    }
    if(Test-Path -LiteralPath $runtime){$backup=Join-Path $RuntimeBase ('backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss'));Move-Item -LiteralPath $runtime -Destination $backup}
    Move-Item -LiteralPath $staging -Destination $runtime
    $pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
    $worker=Join-Path $runtimePlugin 'windows\calendar-sync-worker.ps1'
    $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action Reconcile -Limit 100 -SqlitePath "{1}"' -f $worker,$SqlitePath
    $taskAction=New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
    $trigger=New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings=New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Force|Out-Null
}
Inspect-State|ConvertTo-Json -Compress
