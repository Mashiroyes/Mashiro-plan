[CmdletBinding(DefaultParameterSetName = 'Health')]
param(
    [Parameter(ParameterSetName = 'Health')][switch]$PreCleanup,
    [Parameter(ParameterSetName = 'Health')][switch]$PreStart,
    [Parameter(ParameterSetName = 'Fixture', Mandatory = $true)][switch]$RewriteFixture,
    [Parameter(ParameterSetName = 'Fixture', Mandatory = $true)][string]$FixturePath,
    [Parameter(ParameterSetName = 'Fixture', Mandatory = $true)][string]$FixtureOutput
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$PlanRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$OldRoot = Join-Path $PlanRoot 'script'
$PluginRoot = Join-Path $PlanRoot 'plugin'
$PlanPluginRoot = Join-Path $PluginRoot 'mashirobot-plugin-plan'
$LanguagePluginRoot = Join-Path $PluginRoot 'mashirobot-plugin-language'
$PlanWindowsRoot = Join-Path $PlanPluginRoot 'windows'
$DatabasePath = Join-Path $PlanRoot 'sqlite\openclaw-planner.sqlite'
$AdapterRepair = Join-Path $PlanRoot 'core\adapter\repair-openclaw-adapter.ps1'
$GatewayWrapper = Join-Path $PlanRoot 'core\adapter\start-openclaw-gateway.ps1'
$GatewayTaskName = 'OpenClaw Gateway'
$OperationalTools = Join-Path $env:USERPROFILE '.openclaw\workspace\TOOLS.md'
$GatewayVbs = Join-Path $env:USERPROFILE '.openclaw\gateway.vbs'
$GatewayCmd = Join-Path $env:USERPROFILE '.openclaw\gateway.cmd'
$StablePwshAlias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'

function Get-PathMap {
    $Map = @{}
    foreach ($RelativePath in @(
        'routine-reminder.ps1',
        'plan-reminder-worker.ps1',
        'manage-plan.ps1',
        'check-disk-space.ps1'
    )) {
        $Target = Join-Path $PlanWindowsRoot $RelativePath
        $Map[(Join-Path $OldRoot $RelativePath).ToLowerInvariant()] = $Target
        $Map[(Join-Path $OldRoot ('windows\' + $RelativePath)).ToLowerInvariant()] = $Target
    }
    return $Map
}

function Update-TaskXmlFilePath {
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
        throw "Task XML fixture does not exist: $InputPath"
    }
    $Raw = Get-Content -LiteralPath $InputPath -Raw -Encoding utf8
    [xml]$Xml = $Raw
    $Namespace = [System.Xml.XmlNamespaceManager]::new($Xml.NameTable)
    $Namespace.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $ArgumentNodes = @($Xml.SelectNodes('/t:Task/t:Actions/t:Exec/t:Arguments', $Namespace))
    if ($ArgumentNodes.Count -ne 1) {
        throw "Expected one task Exec Arguments node, found $($ArgumentNodes.Count): $InputPath"
    }

    $Arguments = [string]$ArgumentNodes[0].InnerText
    $FileMatches = [regex]::Matches($Arguments, '(?i)(?:^|\s)-File\s+"(?<path>[^"]+)"')
    if ($FileMatches.Count -ne 1) {
        throw "Expected one quoted -File path, found $($FileMatches.Count): $InputPath"
    }
    $OldFile = $FileMatches[0].Groups['path'].Value
    $PathMap = Get-PathMap
    $MapKey = $OldFile.ToLowerInvariant()
    if (-not $PathMap.ContainsKey($MapKey)) {
        throw "No approved MashiroBot path mapping exists for: $OldFile"
    }
    $NewFile = [string]$PathMap[$MapKey]
    if (-not (Test-Path -LiteralPath $NewFile -PathType Leaf)) {
        throw "Mapped MashiroBot script is missing: $NewFile"
    }

    $ArgumentNodes[0].InnerText = $Arguments.Remove(
        $FileMatches[0].Groups['path'].Index,
        $FileMatches[0].Groups['path'].Length
    ).Insert($FileMatches[0].Groups['path'].Index, $NewFile)

    $OutputDirectory = Split-Path -Parent $OutputPath
    if ($OutputDirectory) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }
    $Settings = [System.Xml.XmlWriterSettings]::new()
    $Settings.Encoding = [Text.UTF8Encoding]::new($false)
    $Settings.Indent = $true
    $Writer = [System.Xml.XmlWriter]::Create($OutputPath, $Settings)
    try { $Xml.Save($Writer) } finally { $Writer.Dispose() }

    return [ordered]@{ oldFile = $OldFile; newFile = $NewFile; output = $OutputPath }
}

if ($PSCmdlet.ParameterSetName -eq 'Fixture') {
    Update-TaskXmlFilePath -InputPath $FixturePath -OutputPath $FixtureOutput | ConvertTo-Json -Depth 4
    exit 0
}

$Checks = [Collections.Generic.List[object]]::new()
$Failures = [Collections.Generic.List[object]]::new()

function Add-HealthCheck {
    param(
        [string]$Name,
        [bool]$Ok,
        [object]$Evidence,
        [ValidateSet('file','registered','heartbeat','verified')][string]$Level = 'file'
    )
    $Entry = [ordered]@{
        name = $Name
        ok = $Ok
        level = $Level
        evidence = $Evidence
        checkedAt = [DateTimeOffset]::Now.ToString('o')
    }
    $Checks.Add($Entry)
    if (-not $Ok) { $Failures.Add($Entry) }
}

function Resolve-PythonPath {
    $Command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Source }
    return $null
}

function Get-ActiveSourceOldReferences {
    $References = [Collections.Generic.List[string]]::new()
    $SourceRoots = @(
        (Join-Path $PlanRoot 'core'),
        $PlanPluginRoot,
        $LanguagePluginRoot
    )
    foreach ($SourceRoot in $SourceRoots) {
        if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { continue }
        $Files = Get-ChildItem -LiteralPath $SourceRoot -Recurse -File |
            Where-Object {
                $_.Extension -in @('.mjs','.js','.ps1','.py') -and
                $_.FullName -notlike '*\tests\*' -and
                $_.FullName -notlike '*\__pycache__\*' -and
                $_.FullName -ne $AdapterRepair
            }
        foreach ($File in $Files) {
            $Text = Get-Content -LiteralPath $File.FullName -Raw -Encoding utf8
            if ($Text.Contains($OldRoot) -or $Text.Contains(($OldRoot -replace '\\','/'))) {
                $References.Add($File.FullName)
            }
        }
    }
    return @($References)
}

try {
    $Pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    Add-HealthCheck 'powershell7' ($null -ne $Pwsh) $(if ($Pwsh) { $Pwsh.Source } else { 'pwsh.exe not found' })

    $Node = Get-Command node.exe -ErrorAction SilentlyContinue
    Add-HealthCheck 'node' ($null -ne $Node) $(if ($Node) { $Node.Source } else { 'node.exe not found' })

    $Python = Resolve-PythonPath
    $PythonOk = $false
    if ($Python) {
        & $Python --version *> $null
        $PythonOk = $LASTEXITCODE -eq 0
    }
    Add-HealthCheck 'python' $PythonOk $(if ($Python) { $Python } else { 'python.exe not found' })
    $PillowOk = $false
    if ($PythonOk) {
        & $Python -c 'from PIL import Image; print(Image.__version__)' *> $null
        $PillowOk = $LASTEXITCODE -eq 0
    }
    Add-HealthCheck 'python-pillow' $PillowOk $(if ($PillowOk) { 'Pillow import succeeded' } else { 'Pillow unavailable from system python.exe' })

    $ManifestPath = Join-Path $PlanPluginRoot 'plugin.json'
    $ManifestOk = $false
    $ManifestDetail = $ManifestPath
    try {
        $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        $ManifestOk = ($Manifest.id -eq 'mashirobot-plugin-plan' -and $Manifest.menuIndex -eq 1 -and $Manifest.enabled)
    } catch { $ManifestDetail = $_.Exception.Message }
    Add-HealthCheck 'plan-plugin-manifest' $ManifestOk $ManifestDetail

    $LanguageManifestPath = Join-Path $LanguagePluginRoot 'plugin.json'
    $LanguageManifestOk = $false
    $LanguageManifestDetail = $LanguageManifestPath
    try {
        $LanguageManifest = Get-Content -LiteralPath $LanguageManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        $LanguageManifestOk = ($LanguageManifest.id -eq 'mashirobot-plugin-language' -and $LanguageManifest.menuIndex -eq 6 -and $LanguageManifest.enabled)
    } catch { $LanguageManifestDetail = $_.Exception.Message }
    Add-HealthCheck 'language-plugin-manifest' $LanguageManifestOk $LanguageManifestDetail

    $GameManifestPath = Join-Path $PluginRoot 'mashirobot-plugin-game-timer\plugin.json'
    $GameManifestOk = $false
    $GameManifestDetail = $GameManifestPath
    try {
        $GameManifest = Get-Content -LiteralPath $GameManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        $GameManifestOk = ($GameManifest.id -eq 'mashirobot-plugin-game-timer' -and $GameManifest.menuIndex -eq 2 -and $GameManifest.enabled)
    } catch { $GameManifestDetail = $_.Exception.Message }
    Add-HealthCheck 'game-timer-plugin-manifest' $GameManifestOk $GameManifestDetail

    $StatusManifestPath = Join-Path $PluginRoot 'mashirobot-plugin-status\plugin.json'
    $StatusManifestOk = $false
    $StatusManifestDetail = $StatusManifestPath
    try {
        $StatusManifest = Get-Content -LiteralPath $StatusManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        $StatusManifestOk = ($StatusManifest.id -eq 'mashirobot-plugin-status' -and $StatusManifest.menuIndex -eq 3 -and $StatusManifest.enabled)
    } catch { $StatusManifestDetail = $_.Exception.Message }
    Add-HealthCheck 'status-plugin-manifest' $StatusManifestOk $StatusManifestDetail

    $LootManifestPath = Join-Path $PluginRoot 'mashirobot-plugin-loot\plugin.json'
    $LootManifestOk = $false
    $LootManifestDetail = $LootManifestPath
    try {
        $LootManifest = Get-Content -LiteralPath $LootManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        $LootManifestOk = ($LootManifest.id -eq 'mashirobot-plugin-loot' -and $LootManifest.menuIndex -eq 4 -and $LootManifest.enabled)
    } catch { $LootManifestDetail = $_.Exception.Message }
    Add-HealthCheck 'loot-plugin-manifest' $LootManifestOk $LootManifestDetail

    $PluginHealthOk = $false
    $PluginHealthDetail = 'node unavailable'
    if ($Node) {
        $LoaderUri = ([uri](Join-Path $PlanRoot 'core\loader\plugin-loader.mjs')).AbsoluteUri
        $HealthUri = ([uri](Join-Path $PlanPluginRoot 'health.mjs')).AbsoluteUri
        $PluginRootJson = $PluginRoot | ConvertTo-Json -Compress
        $NodeCode = @"
import { loadPlugins } from "$LoaderUri";
import { collectPluginHealth } from "$HealthUri";
const registry = await loadPlugins({ pluginRoot: $PluginRootJson });
const health = await collectPluginHealth(registry);
console.log(JSON.stringify({ loaded: registry.plugins.map((entry) => entry.manifest.id), failures: registry.failures, health }));
"@
        $PluginOutput = (& $Node.Source --input-type=module --eval $NodeCode 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) {
            try {
                $PluginResult = $PluginOutput | ConvertFrom-Json
                $PluginHealthOk = (@($PluginResult.failures).Count -eq 0 -and
                    @($PluginResult.loaded) -contains 'mashirobot-plugin-plan' -and
                    @($PluginResult.loaded) -contains 'mashirobot-plugin-language' -and
                    @($PluginResult.loaded) -contains 'mashirobot-plugin-game-timer' -and
                    @($PluginResult.loaded) -contains 'mashirobot-plugin-status' -and
                    @($PluginResult.loaded) -contains 'mashirobot-plugin-loot' -and
                    $PluginResult.health.'mashirobot-plugin-plan'.ok -and
                    $PluginResult.health.'mashirobot-plugin-language'.ok -and
                    $PluginResult.health.'mashirobot-plugin-game-timer'.ok -and
                    $PluginResult.health.'mashirobot-plugin-status'.ok -and
                    $PluginResult.health.'mashirobot-plugin-loot'.ok)
                $PluginHealthDetail = $PluginResult
            } catch { $PluginHealthDetail = $PluginOutput }
        } else { $PluginHealthDetail = $PluginOutput }
    }
    Add-HealthCheck 'plugin-discovery-and-health' $PluginHealthOk $PluginHealthDetail 'verified'

    $DbOk = $false
    $DbDetail = 'database or python missing'
    if ($Python -and (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
        $DbOutput = (& $Python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("PRAGMA integrity_check").fetchone()[0]); c.close()' $DatabasePath 2>&1 | Out-String).Trim()
        $DbOk = ($LASTEXITCODE -eq 0 -and $DbOutput -eq 'ok')
        $DbDetail = $DbOutput
    }
    Add-HealthCheck 'sqlite-integrity' $DbOk $DbDetail 'verified'

    $AdapterOk = $false
    $AdapterDetail = 'adapter repair script or pwsh missing'
    if ($Pwsh -and (Test-Path -LiteralPath $AdapterRepair -PathType Leaf)) {
        $AdapterOutput = (& $Pwsh.Source -NoProfile -File $AdapterRepair -WhatIfReport 2>&1 | Out-String).Trim()
        $AdapterOk = ($LASTEXITCODE -eq 0 -and $AdapterOutput -match 'fast-routine\.js\s+\|\s+state=Canonical' -and $AdapterOutput -match 'process-message\.js\s+\|\s+state=Canonical')
        $AdapterDetail = $AdapterOutput
    }
    Add-HealthCheck 'installed-openclaw-adapter' $AdapterOk $AdapterDetail 'verified'

    $TaskOldReferences = [Collections.Generic.List[object]]::new()
    $OpenClawTasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'OpenClaw*' })
    foreach ($Task in $OpenClawTasks) {
        foreach ($Action in @($Task.Actions)) {
            $ActionText = ([string]$Action.Execute) + ' ' + ([string]$Action.Arguments)
            if ($ActionText.Contains($OldRoot)) {
                $TaskOldReferences.Add([ordered]@{ taskPath = $Task.TaskPath; taskName = $Task.TaskName; action = $ActionText })
            }
        }
    }
    Add-HealthCheck 'scheduled-task-old-root' ($TaskOldReferences.Count -eq 0) @($TaskOldReferences) 'verified'

    $GatewayTask = $OpenClawTasks | Where-Object { $_.TaskName -eq $GatewayTaskName } | Select-Object -First 1
    $GatewayDetail = if ($GatewayTask) { [ordered]@{ execute = $GatewayTask.Actions[0].Execute; arguments = $GatewayTask.Actions[0].Arguments } } else { 'task missing' }
    $GatewayOk = $null -ne $GatewayTask
    if ($PreStart -and $GatewayTask) {
        $GatewayExecute = [string]$GatewayTask.Actions[0].Execute
        $GatewayPowerShellOk = $null -ne $Pwsh -and (
            $GatewayExecute.Equals([string]$Pwsh.Source, [StringComparison]::OrdinalIgnoreCase) -or
            ($GatewayExecute.Equals($StablePwshAlias, [StringComparison]::OrdinalIgnoreCase) -and
                (Test-Path -LiteralPath $StablePwshAlias -PathType Leaf))
        )
        $GatewayOk = $GatewayPowerShellOk -and
            ([string]$GatewayTask.Actions[0].Arguments).Contains($GatewayWrapper)
    }
    Add-HealthCheck 'gateway-task' $GatewayOk $GatewayDetail 'registered'

    $QqTaskName = 'MashiroBot-QQSession-Reconcile'
    $QqTask = Get-ScheduledTask -TaskName $QqTaskName -ErrorAction SilentlyContinue
    $QqStatusPath = Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq\last-status.json'
    $QqHeartbeatOk = $false
    $QqHeartbeatDetail = [ordered]@{
        task = $QqTaskName
        registered = ($null -ne $QqTask)
        statusPath = $QqStatusPath
        status = $null
        ageSeconds = $null
    }
    if ($QqTask -and (Test-Path -LiteralPath $QqStatusPath -PathType Leaf)) {
        try {
            $QqStatus = Get-Content -LiteralPath $QqStatusPath -Raw -Encoding utf8 | ConvertFrom-Json
            $QqAge = [DateTimeOffset]::UtcNow - [DateTimeOffset](Get-Item -LiteralPath $QqStatusPath).LastWriteTimeUtc
            $QqHeartbeatDetail.status = $QqStatus
            $QqHeartbeatDetail.ageSeconds = [Math]::Round($QqAge.TotalSeconds, 3)
            $QqHeartbeatOk = ($QqAge.TotalMinutes -le 12 -and $QqStatus.ok)
        } catch { $QqHeartbeatDetail.status = $_.Exception.Message }
    }
    Add-HealthCheck 'qq-session-heartbeat' $QqHeartbeatOk $QqHeartbeatDetail 'heartbeat'

    $CronOldReferences = [Collections.Generic.List[object]]::new()
    if ($PreStart) {
        # The gateway is intentionally offline while the startup wrapper runs.
        # Online cron verification belongs to PreCleanup/normal health checks;
        # requiring it here would prevent the gateway from ever starting.
        Add-HealthCheck 'openclaw-cron-old-root' $true 'deferred until gateway is online' 'registered'
    } else {
        $CronDetail = 'openclaw unavailable'
        $OpenClaw = Get-Command openclaw -ErrorAction SilentlyContinue
        if ($OpenClaw) {
            $CronText = (& $OpenClaw.Source cron list --json 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0) {
                try {
                    $Cron = $CronText | ConvertFrom-Json
                    foreach ($Job in @($Cron.jobs)) {
                        $PayloadText = $Job.payload | ConvertTo-Json -Depth 12 -Compress
                        if ($PayloadText.Contains($OldRoot.Replace('\', '\\'))) {
                            $CronOldReferences.Add([ordered]@{ id = $Job.id; name = $Job.name; payload = $Job.payload })
                        }
                    }
                    $CronDetail = [ordered]@{ total = @($Cron.jobs).Count; oldRootReferences = @($CronOldReferences) }
                } catch { $CronDetail = $CronText; $CronOldReferences.Add([ordered]@{ parseError = $_.Exception.Message }) }
            } else { $CronDetail = $CronText; $CronOldReferences.Add([ordered]@{ commandError = $CronText }) }
        } else { $CronOldReferences.Add([ordered]@{ commandError = 'openclaw not found' }) }
        Add-HealthCheck 'openclaw-cron-old-root' ($CronOldReferences.Count -eq 0) $CronDetail 'verified'
    }

    $OperationalReferences = [Collections.Generic.List[object]]::new()
    foreach ($Path in @($OperationalTools, $GatewayVbs, $GatewayCmd)) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            $OperationalReferences.Add([ordered]@{ path = $Path; issue = 'missing' })
            continue
        }
        $Text = Get-Content -LiteralPath $Path -Raw -Encoding utf8
        if ($Text.Contains($OldRoot) -or $Text.Contains(($OldRoot -replace '\\','/'))) {
            $OperationalReferences.Add([ordered]@{ path = $Path; issue = 'old-root-reference' })
        }
    }
    Add-HealthCheck 'operational-entrypoints' ($OperationalReferences.Count -eq 0) @($OperationalReferences)

    $SourceOldReferences = Get-ActiveSourceOldReferences
    Add-HealthCheck 'active-source-old-root' (@($SourceOldReferences).Count -eq 0) @($SourceOldReferences) 'verified'

    $HelpOk = $false
    $HelpDetail = 'python unavailable'
    if ($Python) {
        $HelpRoot = Join-Path ([IO.Path]::GetTempPath()) ('MashiroBot\health-' + [guid]::NewGuid().ToString('N'))
        $HelpOutput = Join-Path $HelpRoot 'help.png'
        try {
            $Payload = [ordered]@{
                kind = 'main'
                plugins = @(
                    [ordered]@{ name = '计划'; description = '计划、记录、作息与提醒'; menuIndex = 1 },
                    [ordered]@{ name = '游戏计时与禁止名单'; description = '游戏限时提醒、超时强退和禁止规则'; menuIndex = 2 },
                    [ordered]@{ name = '状态'; description = 'Windows 系统状态与硬件信息图片'; menuIndex = 3 },
                    [ordered]@{ name = '战利品'; description = '记录当天最后一次爽点并在次日回放'; menuIndex = 4 }
                )
                unavailablePluginCount = 0
            } | ConvertTo-Json -Depth 6 -Compress
            $PayloadBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Payload))
            $Renderer = Join-Path $PlanRoot 'core\menu\render_help.py'
            & $Python $Renderer --payload-base64 $PayloadBase64 --output $HelpOutput *> $null
            $HelpOk = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $HelpOutput -PathType Leaf) -and (Get-Item -LiteralPath $HelpOutput).Length -gt 1000)
            $HelpDetail = $HelpOutput
        } catch { $HelpDetail = $_.Exception.Message } finally {
            if (Test-Path -LiteralPath $HelpRoot) { Remove-Item -LiteralPath $HelpRoot -Recurse -Force }
        }
    }
    Add-HealthCheck 'temporary-help-render' $HelpOk $HelpDetail 'verified'

    $Result = [ordered]@{
        ok = ($Failures.Count -eq 0)
        mode = if ($PreStart) { 'PreStart' } elseif ($PreCleanup) { 'PreCleanup' } else { 'Health' }
        failures = @($Failures)
        checks = @($Checks)
    }
    $Result | ConvertTo-Json -Depth 14
    if ($Failures.Count) { exit 1 }
    exit 0
} catch {
    $Failure = [ordered]@{ name = 'health-script'; ok = $false; level = 'verified'; evidence = $_.Exception.Message; checkedAt = [DateTimeOffset]::Now.ToString('o') }
    [ordered]@{ ok = $false; mode = 'exception'; failures = @($Failure); checks = @($Checks) } |
        ConvertTo-Json -Depth 14
    exit 1
}
