[CmdletBinding()]
param(
    [ValidateSet('Install','Remove','Status')][string]$Mode = 'Status',
    [Parameter(Mandatory = $false)][string]$SqlitePath,
    [string]$StateRoot = (Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-block')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$pluginRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = Join-Path $StateRoot 'workers'
$worker = Join-Path $workerRoot 'block-worker-v2.ps1'
$helper = Join-Path $workerRoot 'block-db-v1.mjs'
$sourceWorker = Join-Path $PSScriptRoot 'BlockWorker.ps1'
$sourceHelper = Join-Path $PSScriptRoot 'block-db-v1.mjs'
$legacyTemplate = Join-Path $workerRoot 'bilibili-qq-expiry.default.json'
$sourceLegacyTemplate = Join-Path $PSScriptRoot 'bilibili-qq-expiry.default.json'
$reapplyTask = 'MashiroBot-mashirobot-plugin-block-Reapply'
$scanTask = 'MashiroBot-mashirobot-plugin-block-Scan'
$statePath = Join-Path $StateRoot 'state.json'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Install/remove requires an elevated Administrator process.' }
}

function Remove-Tasks {
    foreach ($name in @($reapplyTask, $scanTask)) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
}

function Assert-TaskAction([string]$name, [string]$expectedWorker) {
    [xml]$xml = Export-ScheduledTask -TaskName $name -ErrorAction Stop
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $args = [string]$xml.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments', $ns).InnerText
    if ($args -notmatch [regex]::Escape($expectedWorker)) { throw "Task action mismatch: $name" }
}

function Grant-TaskRunAccess([string]$name) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $task = $service.GetFolder('\').GetTask($name)
    $sddl = [string]$task.GetSecurityDescriptor(0xF)
    $ace = "(A;;GRGX;;;$sid)"
    if ($sddl -match [regex]::Escape($ace)) { return }
    if ($sddl -match 'S:') { $sddl = $sddl -replace 'S:', ($ace + 'S:') } else { $sddl += $ace }
    $task.SetSecurityDescriptor($sddl, 0)
}

function Register-RecurringTask([string]$name, [int]$minutes, [string]$mode) {
    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { throw "PowerShell 7 not found: $pwsh" }
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode {1} -SqlitePath "{2}" -StateRoot "{3}"' -f $worker, $mode, $SqlitePath, $StateRoot
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $triggers = @(
        (New-ScheduledTaskTrigger -AtStartup),
        (New-ScheduledTaskTrigger -AtLogOn),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $minutes) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $definition = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $name -InputObject $definition -Force | Out-Null
    Enable-ScheduledTask -TaskName $name | Out-Null
    Assert-TaskAction $name $worker
    Grant-TaskRunAccess $name
}

function Install-Block {
    Assert-Administrator
    if (-not $SqlitePath -or -not (Test-Path -LiteralPath $SqlitePath -PathType Leaf)) { throw 'Install requires an existing SQLite database path.' }
    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    New-Item -ItemType Directory -Path $workerRoot -Force | Out-Null
    Copy-Item -LiteralPath $sourceWorker -Destination $worker -Force
    Copy-Item -LiteralPath $sourceHelper -Destination $helper -Force
    Copy-Item -LiteralPath $sourceLegacyTemplate -Destination $legacyTemplate -Force
    $state = [ordered]@{ UserProfile=$env:USERPROFILE; ClashRoot=(Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'); IfeoBackups=@(); PolicyBackups=@(); ClashManagedDomains=@(); ClashReloadPending=$false; LegacyBilibiliDelegated=$false; LegacyBilibiliReleaseBefore=$null; InstalledAt=(Get-Date).ToString('o') }
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
    Remove-Tasks
    Register-RecurringTask $reapplyTask 5 'Reapply'
    Register-RecurringTask $scanTask 1 'Scan'
    $initialOutput = @(& $pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -Mode Reapply -SqlitePath $SqlitePath -StateRoot $StateRoot 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Initial block synchronization failed: $($initialOutput -join [Environment]::NewLine)" }
    $verifiedState = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
    if (-not $verifiedState.LastSync.ok) { throw "Initial block synchronization did not produce a verified success state." }
    [ordered]@{ ok=$true; mode='Install'; worker=$worker; tasks=@($reapplyTask,$scanTask) } | ConvertTo-Json -Depth 5
}

function Remove-Block {
    Assert-Administrator
    Remove-Tasks
    if (Test-Path -LiteralPath $worker) { $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source; & $pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -Mode Remove -SqlitePath $SqlitePath -StateRoot $StateRoot }
    [ordered]@{ ok=$true; mode='Remove'; removedTasks=@($reapplyTask,$scanTask) } | ConvertTo-Json -Depth 5
}

function Get-Status {
    $tasks = @(foreach ($name in @($reapplyTask,$scanTask)) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) { continue }
        $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
        [ordered]@{ taskName=$task.TaskName; state=[string]$task.State; lastRun=if($info){$info.LastRunTime.ToString('o')}else{$null}; lastResult=if($info){$info.LastTaskResult}else{$null}; action=$task.Actions[0].Execute; arguments=$task.Actions[0].Arguments }
    })
    $lastSync = if (Test-Path -LiteralPath $statePath) { try { (Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json).LastSync } catch { $null } } else { $null }
    [ordered]@{ ok=([bool](Test-Path -LiteralPath $worker) -and $tasks.Count -eq 2 -and [bool]$lastSync.ok); mode='Status'; workerExists=(Test-Path -LiteralPath $worker); tasks=$tasks; stateExists=(Test-Path -LiteralPath $statePath); lastSync=$lastSync } | ConvertTo-Json -Depth 8
}

switch ($Mode) { 'Install' { Install-Block }; 'Remove' { Remove-Block }; 'Status' { Get-Status } }
