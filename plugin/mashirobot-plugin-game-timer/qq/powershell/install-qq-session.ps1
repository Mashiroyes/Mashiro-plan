[CmdletBinding()]
param(
    [ValidateSet('Install','Prepare','Capture','Recover','Status','Remove')][string]$Mode = 'Status',
    [string]$SqlitePath,
    [string]$SessionId,
    [string]$InstallerPath,
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
$coreRoot = Join-Path (Split-Path -Parent $StateRoot) 'core'
$storage = Join-Path $coreRoot 'qq-session-storage-v2.mjs'
$model = Join-Path $coreRoot 'qq-session-model.mjs'
$configPath = Join-Path $StateRoot 'config.json'
$lastStatusPath = Join-Path $StateRoot 'last-status.json'
$taskName = 'MashiroBot-QQSession-Reconcile'
$launchTaskName = 'MashiroBot-QQSession-Launch'

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

function Invoke-WorkerStatus {
    $config = Get-InstalledConfig
    if (-not $config -or -not (Test-Path -LiteralPath $worker)) { return $null }
    $raw = & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -Mode Status `
        -SqlitePath ([string]$config.SqlitePath) -StateRoot $StateRoot -FocusLockRoot $FocusLockRoot
    if ($LASTEXITCODE -ne 0) { throw "QQ worker status failed: $raw" }
    return $raw | ConvertFrom-Json -DateKind String
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
    $sourceStorage = Join-Path $pluginRoot 'core\qq-session-storage.mjs'
    $sourceModel = Join-Path $pluginRoot 'core\qq-session-model.mjs'
    New-Item -ItemType Directory -Path $workerRoot,$coreRoot -Force | Out-Null
    Copy-Item -LiteralPath $sourceWorker -Destination $worker -Force
    Copy-Item -LiteralPath $sourceHelper -Destination $helper -Force
    Copy-Item -LiteralPath $sourceStorage -Destination $storage -Force
    Copy-Item -LiteralPath $sourceModel -Destination $model -Force

    $userProfile = $env:USERPROFILE
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $downloadsPath = Join-Path $userProfile 'Downloads'
    $clashRoot = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
    $config = [ordered]@{
        SqlitePath=$resolvedDb; StateRoot=$StateRoot; FocusLockRoot=$FocusLockRoot
        UserProfile=$userProfile; DesktopPath=$desktopPath; DownloadsPath=$downloadsPath; ClashRoot=$clashRoot
        InstalledAt=(Get-Date).ToString('o')
    }
    $config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8

    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode Watch -SqlitePath "{1}" -StateRoot "{2}" -FocusLockRoot "{3}"' -f `
        $worker,$resolvedDb,$StateRoot,$FocusLockRoot
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
    $triggers = @(
        (New-ScheduledTaskTrigger -AtStartup),
        (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    $definition = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
    Grant-TaskRunAccess $taskName
    [xml]$xml = Export-ScheduledTask -TaskName $taskName
    if ([string]$xml.Task.Actions.Exec.Arguments -notmatch [regex]::Escape($worker)) { throw 'QQ task action verification failed.' }

    $launchArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode LaunchInteractive -SqlitePath "{1}" -StateRoot "{2}" -FocusLockRoot "{3}"' -f `
        $worker,$resolvedDb,$StateRoot,$FocusLockRoot
    $launchAction = New-ScheduledTaskAction -Execute $pwsh -Argument $launchArguments
    $launchPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $launchSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
    Register-ScheduledTask -TaskName $launchTaskName -Action $launchAction -Principal $launchPrincipal -Settings $launchSettings -Force | Out-Null
    Grant-TaskRunAccess $launchTaskName
    [xml]$launchXml = Export-ScheduledTask -TaskName $launchTaskName
    if ([string]$launchXml.Task.Actions.Exec.Arguments -notmatch 'LaunchInteractive') { throw 'QQ interactive launch task verification failed.' }
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
    & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -Mode Capture `
        -SqlitePath ([string]$config.SqlitePath) -StateRoot $StateRoot -FocusLockRoot $FocusLockRoot -InstallerPath $InstallerPath
    if ($LASTEXITCODE -ne 0) { throw 'QQ installer capture failed.' }
}

function Recover-QQSession {
    $config = Get-InstalledConfig
    if (-not $config) { throw 'QQ session worker is not installed.' }
    & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -Mode Recover `
        -SqlitePath ([string]$config.SqlitePath) -StateRoot $StateRoot -FocusLockRoot $FocusLockRoot
    if ($LASTEXITCODE -ne 0) { throw 'QQ session recovery failed.' }
}

function Remove-QQSession {
    Assert-Administrator
    $config = Get-InstalledConfig
    if ($config -and (Test-Path -LiteralPath $worker)) {
        & pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $worker -Mode Recover `
            -SqlitePath ([string]$config.SqlitePath) -StateRoot $StateRoot -FocusLockRoot $FocusLockRoot | Out-Null
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $launchTaskName -Confirm:$false -ErrorAction SilentlyContinue
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
