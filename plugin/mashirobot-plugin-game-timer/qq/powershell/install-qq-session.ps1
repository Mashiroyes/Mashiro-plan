[CmdletBinding()]
param(
    [ValidateSet('Install','Prepare','Capture','Recover','Status','Remove')][string]$Mode = 'Status',
    [string]$SqlitePath,
    [string]$SessionId,
    [string]$InstallerPath,
    [string]$RuntimeDescriptorPath,
    [string]$StateRoot = (Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq'),
    [string]$FocusLockRoot = (Join-Path $env:ProgramData 'CodexFocusLock')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$pluginRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$workerRoot = Join-Path $StateRoot 'workers'
$worker = Join-Path $workerRoot 'qq-session-worker-v1.ps1'
$helper = Join-Path $workerRoot 'qq-session-db-v1.mjs'
$containerHelper = Join-Path $workerRoot 'qq-executable-container-v2.ps1'
$coreRoot = Join-Path (Split-Path -Parent $StateRoot) 'core'
$storage = Join-Path $coreRoot 'qq-session-storage-v2.mjs'
$model = Join-Path $coreRoot 'qq-session-model.mjs'
$configPath = Join-Path $StateRoot 'config.json'
$lastStatusPath = Join-Path $StateRoot 'last-status.json'
$taskName = 'MashiroBot-QQSession-Reconcile'
$launchTaskName = 'MashiroBot-QQSession-Launch'
$manualRestoreTaskName = 'MashiroBot-QQSession-ManualRestore'
$manualProtectTaskName = 'MashiroBot-QQSession-ManualProtect'
$maintenanceRestoreTaskName = 'MashiroBot-QQSession-MaintenanceRestore'
$containerConfigPath = Join-Path $StateRoot 'runtime-cache.json'
$planRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
$taskContractPath = Join-Path $planRoot 'core\deployment\task-contract.ps1'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Install/remove requires an elevated Administrator process.' }
}

function Grant-TaskRunAccess([string]$name) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $task = $service.GetFolder('\').GetTask($name)
    $sddl = [string]$task.GetSecurityDescriptor(0xF)
    $ace = "(A;;GRGX;;;$sid)"
    if ($sddl.Contains($ace)) { return }
    if ($sddl -match 'S:') { $sddl = $sddl -replace 'S:', ($ace + 'S:') } else { $sddl += $ace }
    $task.SetSecurityDescriptor($sddl, 0)
}

function Get-InstalledConfig {
    if (-not (Test-Path -LiteralPath $configPath)) { return $null }
    return Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
}

function Set-QQContainerRootAcl([string]$path) {
    $system = [Security.Principal.NTAccount]::new('NT AUTHORITY','SYSTEM')
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($system)
    $acl.SetAccessRuleProtection($true,$false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,'FullControl',$inherit,'None','Allow'))
    Set-Acl -LiteralPath $path -AclObject $acl
    $item=Get-Item -LiteralPath $path -Force
    $item.Attributes=$item.Attributes -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System
}

function Set-QQContainerConfigAcl([string]$path) {
    $system = [Security.Principal.NTAccount]::new('NT AUTHORITY','SYSTEM')
    $administrators = [Security.Principal.NTAccount]::new('BUILTIN','Administrators')
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($system)
    $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system,'FullControl','Allow'))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administrators,'FullControl','Allow'))
    Set-Acl -LiteralPath $path -AclObject $acl
}

function Initialize-QQContainerConfig {
    if (Test-Path -LiteralPath $containerConfigPath -PathType Leaf) {
        $existing=Get-Content -LiteralPath $containerConfigPath -Raw -Encoding UTF8|ConvertFrom-Json
        if(-not$existing.Root){throw 'Existing QQ container configuration has no root.'}
        Set-QQContainerConfigAcl $containerConfigPath
        return [IO.Path]::GetFullPath([string]$existing.Root)
    }
    $name=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(20)).ToLowerInvariant()
    $root=Join-Path $env:ProgramData $name
    New-Item -ItemType Directory -Path $root -Force|Out-Null
    @{Version=2;Root=$root;CreatedAt=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $containerConfigPath -Encoding UTF8
    Set-QQContainerRootAcl $root
    Set-QQContainerConfigAcl $containerConfigPath
    $root
}

function Get-RuntimeContract {
    if ($RuntimeDescriptorPath) {
        $Resolved = [IO.Path]::GetFullPath($RuntimeDescriptorPath)
        if (-not (Test-Path -LiteralPath $Resolved -PathType Leaf)) { throw "Runtime descriptor does not exist: $Resolved" }
        return Get-Content -LiteralPath $Resolved -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    return [pscustomobject]@{ pwshPath=(Get-Command pwsh.exe -ErrorAction Stop).Source; nodePath=(Get-Command node.exe -ErrorAction Stop).Source }
}

function Invoke-WorkerStatus {
    $config = Get-InstalledConfig
    if (-not $config -or -not (Test-Path -LiteralPath $worker)) { return $null }
    if (-not (Test-Path -LiteralPath $lastStatusPath -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $lastStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json -DateKind String
}

function Get-Status {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $last = if (Test-Path -LiteralPath $lastStatusPath) { Get-Content -LiteralPath $lastStatusPath -Raw | ConvertFrom-Json -DateKind String } else { $null }
    $workerStatus = $null
    try { $workerStatus = Invoke-WorkerStatus } catch { $workerStatus = [pscustomobject]@{ ok=$false; error=$_.Exception.Message } }
    return [ordered]@{
        ok = [bool]($task -and (Test-Path -LiteralPath $worker) -and $workerStatus -and $workerStatus.ok)
        mode = 'Status'
        task = if ($task) { [ordered]@{ name=$task.TaskName; state=[string]$task.State } } else { $null }
        launchTask = $launchTaskName
        worker = $worker
        workerExists = Test-Path -LiteralPath $worker
        status = $workerStatus
        lastReconcile = $last
    }
}

function Install-QQSession {
    Assert-Administrator
    if (-not $SqlitePath) { throw 'Install requires -SqlitePath.' }
    $resolvedDb = [IO.Path]::GetFullPath($SqlitePath)
    if (-not (Test-Path -LiteralPath $resolvedDb -PathType Leaf)) { throw "SQLite database does not exist: $resolvedDb" }
    $sourceWorker = Join-Path $PSScriptRoot 'qq-session-worker-v1.ps1'
    $sourceHelper = Join-Path $PSScriptRoot 'qq-session-db-v1.mjs'
    $sourceContainerHelper = Join-Path $PSScriptRoot 'qq-executable-container-v2.ps1'
    $sourceStorage = Join-Path $pluginRoot 'core\qq-session-storage.mjs'
    $sourceModel = Join-Path $pluginRoot 'core\qq-session-model.mjs'
    New-Item -ItemType Directory -Path $workerRoot,$coreRoot -Force | Out-Null
    Copy-Item -LiteralPath $sourceWorker -Destination $worker -Force
    Copy-Item -LiteralPath $sourceHelper -Destination $helper -Force
    Copy-Item -LiteralPath $sourceContainerHelper -Destination $containerHelper -Force
    Copy-Item -LiteralPath $sourceStorage -Destination $storage -Force
    Copy-Item -LiteralPath $sourceModel -Destination $model -Force

    $userProfile = $env:USERPROFILE
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $downloadsPath = Join-Path $userProfile 'Downloads'
    $clashRoot = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
    $runtime = Get-RuntimeContract
    [void](Initialize-QQContainerConfig)
    $config = [ordered]@{
        SqlitePath=$resolvedDb; StateRoot=$StateRoot; FocusLockRoot=$FocusLockRoot
        ContainerConfigPath=$containerConfigPath
        PwshPath=[string]$runtime.pwshPath; NodePath=[string]$runtime.nodePath; RuntimeDescriptorPath=$RuntimeDescriptorPath
        UserProfile=$userProfile; DesktopPath=$desktopPath; DownloadsPath=$downloadsPath; ClashRoot=$clashRoot
        InstalledAt=(Get-Date).ToString('o')
    }
    $config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8

    . $taskContractPath
    $pwsh = [string]$runtime.pwshPath
    $commonRuntimeArguments = @('-SqlitePath',$resolvedDb,'-NodePath',[string]$runtime.nodePath,'-StateRoot',$StateRoot,'-FocusLockRoot',$FocusLockRoot,'-ContainerConfigPath',$containerConfigPath)
    $action = New-MashiroTaskAction -Runtime $runtime -WorkerPath $worker -Arguments (@('-Mode','Watch') + $commonRuntimeArguments)
    $triggers = @(
        (New-ScheduledTaskTrigger -AtStartup),
        (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    $definition = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
    # The ScheduledTasks module omits StopExisting from its generated enum on
    # some Windows builds, although Task Scheduler's XML schema supports it.
    # Re-register through XML so an interactive /Run replaces a sleeping Watch.
    [xml]$taskXml = Export-ScheduledTask -TaskName $taskName
    $taskXml.Task.Settings.MultipleInstancesPolicy = 'StopExisting'
    Register-ScheduledTask -TaskName $taskName -Xml $taskXml.OuterXml -Force | Out-Null
    Grant-TaskRunAccess $taskName
    [xml]$xml = Export-ScheduledTask -TaskName $taskName
    if ([string]$xml.Task.Actions.Exec.Arguments -notmatch [regex]::Escape($worker) -or [string]$xml.Task.Settings.MultipleInstancesPolicy -ne 'StopExisting') { throw 'QQ task action or instance policy verification failed.' }

    $launchAction = New-MashiroTaskAction -Runtime $runtime -WorkerPath $worker -Arguments (@('-Mode','LaunchInteractive') + $commonRuntimeArguments)
    $launchPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $launchSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
    Register-ScheduledTask -TaskName $launchTaskName -Action $launchAction -Principal $launchPrincipal -Settings $launchSettings -Force | Out-Null
    Grant-TaskRunAccess $launchTaskName
    [xml]$launchXml = Export-ScheduledTask -TaskName $launchTaskName
    if ([string]$launchXml.Task.Actions.Exec.Arguments -notmatch 'LaunchInteractive' -or [string]$launchXml.Task.Actions.Exec.Arguments -notmatch [regex]::Escape([string]$runtime.nodePath)) { throw 'QQ interactive launch task verification failed.' }

    foreach($taskSpec in @(
        @{Name=$manualRestoreTaskName;Mode='ManualRestore';Grant=$true},
        @{Name=$manualProtectTaskName;Mode='ManualProtect';Grant=$true},
        @{Name=$maintenanceRestoreTaskName;Mode='MaintenanceRestore';Grant=$false}
    )){
        $maintenanceAction=New-MashiroTaskAction -Runtime $runtime -WorkerPath $worker -Arguments (@('-Mode',[string]$taskSpec.Mode)+$commonRuntimeArguments)
        $maintenanceDefinition=New-ScheduledTask -Action $maintenanceAction -Principal $principal -Settings $settings
        Register-ScheduledTask -TaskName ([string]$taskSpec.Name) -InputObject $maintenanceDefinition -Force|Out-Null
        if($taskSpec.Grant){Grant-TaskRunAccess ([string]$taskSpec.Name)}
    }
    $startedAt=Get-Date
    Start-ScheduledTask -TaskName $taskName
    $deadline=(Get-Date).AddSeconds(90)
    do{Start-Sleep -Milliseconds 200;$fresh=(Test-Path -LiteralPath $lastStatusPath -PathType Leaf) -and (Get-Item -LiteralPath $lastStatusPath).LastWriteTime -ge $startedAt}while(-not $fresh -and (Get-Date) -lt $deadline)
    if(-not $fresh){throw 'QQ SYSTEM reconcile did not publish a fresh status after installation.'}
    $status = Get-Status
    $status.mode = 'Install'
    $status | ConvertTo-Json -Depth 10
}

function Start-QQPreparation {
    if (-not $SessionId) { throw 'Prepare requires -SessionId.' }
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    [ordered]@{ ok=$true; mode='Prepare'; sessionId=$SessionId; task=$taskName; startedAt=(Get-Date).ToString('o') } | ConvertTo-Json
}

function Capture-QQInstaller {
    Assert-Administrator
    if (-not $InstallerPath) { throw 'Capture requires -InstallerPath.' }
    $config = Get-InstalledConfig
    if (-not $config) { throw 'QQ session worker is not installed.' }
    & ([string]$config.PwshPath) -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -Mode Capture `
        -SqlitePath ([string]$config.SqlitePath) -NodePath ([string]$config.NodePath) -StateRoot $StateRoot -FocusLockRoot $FocusLockRoot -ContainerConfigPath $containerConfigPath -InstallerPath $InstallerPath
    if ($LASTEXITCODE -ne 0) { throw 'QQ installer capture failed.' }
}

function Recover-QQSession {
    $config = Get-InstalledConfig
    if (-not $config) { throw 'QQ session worker is not installed.' }
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    [ordered]@{ok=$true;mode='Recover';task=$taskName;startedAt=(Get-Date).ToString('o')}|ConvertTo-Json
}

function Remove-QQSession {
    Assert-Administrator
    $config = Get-InstalledConfig
    if ($config -and (Test-Path -LiteralPath $worker)) {
        $startedAt=Get-Date
        Start-ScheduledTask -TaskName $maintenanceRestoreTaskName -ErrorAction Stop
        $deadline=(Get-Date).AddSeconds(90);$restored=$false
        do{
            Start-Sleep -Milliseconds 200
            if((Test-Path -LiteralPath $lastStatusPath -PathType Leaf) -and (Get-Item -LiteralPath $lastStatusPath).LastWriteTime -ge $startedAt){
                $last=Get-Content -LiteralPath $lastStatusPath -Raw|ConvertFrom-Json -DateKind String
                $restored=[bool]($last.ok -and $last.qqInstalled -and [string]$last.installedExecutableVault.state -eq 'available')
            }
        }while(-not $restored -and (Get-Date) -lt $deadline)
        if(-not $restored){throw 'QQ maintenance restore did not verify the installed executable.'}
    }
    foreach($name in @($taskName,$launchTaskName,$manualRestoreTaskName,$manualProtectTaskName,$maintenanceRestoreTaskName)){Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue}
    [ordered]@{ ok=$true; mode='Remove'; task=$taskName } | ConvertTo-Json
}

switch ($Mode) {
    'Install' { Install-QQSession }
    'Prepare' { Start-QQPreparation }
    'Capture' { Capture-QQInstaller }
    'Recover' { Recover-QQSession }
    'Status' { (Get-Status) | ConvertTo-Json -Depth 10 }
    'Remove' { Remove-QQSession }
}
