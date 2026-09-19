[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PlanRoot = Split-Path -Parent $PSScriptRoot
$AdapterRoot = Join-Path $PlanRoot 'core\adapter'
$RepairScript = Join-Path $AdapterRoot 'repair-openclaw-adapter.ps1'
$CanonicalAdapter = Join-Path $AdapterRoot 'fast-routine.adapter.js'
$IndexUri = ([Uri](Join-Path $PlanRoot 'core\index.mjs')).AbsoluteUri
$GatewayWrapper = Join-Path $AdapterRoot 'start-openclaw-gateway.ps1'
$HealthScript = Join-Path $PlanRoot 'core\health\check-mashirobot.ps1'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "ASSERTION FAILED: $Message`nExpected: $Expected`nActual:   $Actual"
    }
}

function New-FakePackage {
    param(
        [Parameter(Mandatory)][string]$Root,
        [ValidateSet('KnownOld', 'Canonical', 'UnknownFast', 'UnknownProcess')]
        [string]$Layout = 'KnownOld'
    )

    $Messaging = Join-Path $Root 'dist\src\messaging'
    New-Item -ItemType Directory -Path $Messaging -Force | Out-Null

    $OldFast = @'
import { runPlanner } from "file:///D:/BaiduSyncdisk/Study/AI/codex/codex-study/plan/script/bridge/openclaw-router.mjs";
export function handleFastRoutineCommand(rawText, now = new Date()) {
  return runPlanner(rawText, now);
}
'@
    $UnknownFast = 'export const unrelatedPackageEntry = true;'
    $ProcessOld = @'
import { handleFastRoutineCommand } from "./fast-routine.js";
export async function process(rawBody, deps, full, ctx) {
  const fastRoutineResult = handleFastRoutineCommand(rawBody);
  return fastRoutineResult;
}
'@
    $ProcessNew = @'
import { handleFastRoutineCommand } from "./fast-routine.js";
export async function process(rawBody, deps, full, ctx) {
  const fastRoutineResult = await handleFastRoutineCommand(rawBody, {
    accountId: deps.accountId,
    conversationId: full.from_user_id ?? ctx.To ?? "",
    now: new Date(),
  });
  return fastRoutineResult;
}
'@
    $UnknownProcess = @'
import { handleFastRoutineCommand } from "./fast-routine.js";
export function process(rawBody) {
  return handleFastRoutineCommand(rawBody, { source: "unknown" });
}
'@

    switch ($Layout) {
        'KnownOld' {
            Set-Content -LiteralPath (Join-Path $Messaging 'fast-routine.js') -Value $OldFast -Encoding utf8 -NoNewline
            Set-Content -LiteralPath (Join-Path $Messaging 'process-message.js') -Value $ProcessOld -Encoding utf8 -NoNewline
        }
        'Canonical' {
            Set-Content -LiteralPath (Join-Path $Messaging 'fast-routine.js') -Value $script:GeneratedCanonicalText -Encoding utf8 -NoNewline
            Set-Content -LiteralPath (Join-Path $Messaging 'process-message.js') -Value $ProcessNew -Encoding utf8 -NoNewline
        }
        'UnknownFast' {
            Set-Content -LiteralPath (Join-Path $Messaging 'fast-routine.js') -Value $UnknownFast -Encoding utf8 -NoNewline
            Set-Content -LiteralPath (Join-Path $Messaging 'process-message.js') -Value $ProcessOld -Encoding utf8 -NoNewline
        }
        'UnknownProcess' {
            Set-Content -LiteralPath (Join-Path $Messaging 'fast-routine.js') -Value $OldFast -Encoding utf8 -NoNewline
            Set-Content -LiteralPath (Join-Path $Messaging 'process-message.js') -Value $UnknownProcess -Encoding utf8 -NoNewline
        }
    }

    return $Messaging
}

function Invoke-RepairExpectFailure {
    param([string]$PackageRoot, [string]$NodePath = 'node')
    $global:LASTEXITCODE = 0
    & $RepairScript -PackageRoot $PackageRoot -NodePath $NodePath 2>&1 | Out-Null
    return $LASTEXITCODE
}

Assert-True (Test-Path -LiteralPath $RepairScript -PathType Leaf) 'repair script must exist'
Assert-True (Test-Path -LiteralPath $CanonicalAdapter -PathType Leaf) 'canonical adapter must exist'
Assert-True (Test-Path -LiteralPath $GatewayWrapper -PathType Leaf) 'gateway wrapper must exist'
Assert-True (Test-Path -LiteralPath $HealthScript -PathType Leaf) 'health script must exist'

$CanonicalText = Get-Content -LiteralPath $CanonicalAdapter -Raw -Encoding utf8
$script:GeneratedCanonicalText = $CanonicalText.Replace('__MASHIROBOT_INDEX_URI__', $IndexUri)
Assert-True ($CanonicalText -match 'handleMashiroBotMessage as handleFastRoutineCommand') 'canonical adapter must export the MashiroBot handler'
Assert-True ($CanonicalText -match '__MASHIROBOT_INDEX_URI__') 'canonical adapter must use the generated index URI placeholder'

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("MashiroBotAdapterTest-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempRoot | Out-Null

try {
    # WhatIf report must identify both changes without writing or backing up.
    $WhatIfRoot = Join-Path $TempRoot 'whatif'
    $WhatIfMessaging = New-FakePackage -Root $WhatIfRoot -Layout KnownOld
    $BeforeFast = Get-Content -LiteralPath (Join-Path $WhatIfMessaging 'fast-routine.js') -Raw -Encoding utf8
    $BeforeProcess = Get-Content -LiteralPath (Join-Path $WhatIfMessaging 'process-message.js') -Raw -Encoding utf8
    $Report = (& $RepairScript -PackageRoot $WhatIfRoot -WhatIfReport 2>&1) -join "`n"
    Assert-Equal 0 $LASTEXITCODE 'WhatIf report must succeed'
    Assert-True ($Report -match [regex]::Escape((Join-Path $WhatIfMessaging 'fast-routine.js'))) 'WhatIf must name fast-routine.js'
    Assert-True ($Report -match [regex]::Escape((Join-Path $WhatIfMessaging 'process-message.js'))) 'WhatIf must name process-message.js'
    Assert-True ($Report -match 'replace full file') 'WhatIf must describe full adapter replacement'
    Assert-True ($Report -match 'replace fast-handler call only') 'WhatIf must describe the guarded call replacement'
    Assert-Equal $BeforeFast (Get-Content -LiteralPath (Join-Path $WhatIfMessaging 'fast-routine.js') -Raw -Encoding utf8) 'WhatIf must not change fast-routine.js'
    Assert-Equal $BeforeProcess (Get-Content -LiteralPath (Join-Path $WhatIfMessaging 'process-message.js') -Raw -Encoding utf8) 'WhatIf must not change process-message.js'
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $WhatIfMessaging -Filter '*.bak.mashirobot-*').Count 'WhatIf must not create backups'

    # Clean known-old repair creates one backup for each file and is idempotent.
    $KnownRoot = Join-Path $TempRoot 'known-old'
    $KnownMessaging = New-FakePackage -Root $KnownRoot -Layout KnownOld
    & $RepairScript -PackageRoot $KnownRoot | Out-Null
    Assert-Equal 0 $LASTEXITCODE 'known old layout must repair successfully'
    Assert-Equal $script:GeneratedCanonicalText (Get-Content -LiteralPath (Join-Path $KnownMessaging 'fast-routine.js') -Raw -Encoding utf8) 'installed fast adapter must point at the current checkout'
    $PatchedProcess = Get-Content -LiteralPath (Join-Path $KnownMessaging 'process-message.js') -Raw -Encoding utf8
    Assert-True ($PatchedProcess -match 'accountId: deps\.accountId') 'patched call must pass accountId'
    Assert-True ($PatchedProcess -match 'conversationId: full\.from_user_id \?\? ctx\.To \?\? ""') 'patched call must pass conversationId'
    Assert-True ($PatchedProcess -match 'now: new Date\(\)') 'patched call must pass now'
    Assert-True ($PatchedProcess -match 'const\s+fastRoutineResult\s*=\s*await\s+handleFastRoutineCommand') 'patched call must await the asynchronous router'
    $BackupCount = @(Get-ChildItem -LiteralPath $KnownMessaging -Filter '*.bak.mashirobot-*').Count
    Assert-Equal 2 $BackupCount 'first repair must create exactly two backups'
    & $RepairScript -PackageRoot $KnownRoot | Out-Null
    Assert-Equal 0 $LASTEXITCODE 'second repair must succeed'
    Assert-Equal $BackupCount @(Get-ChildItem -LiteralPath $KnownMessaging -Filter '*.bak.mashirobot-*').Count 'second repair must not create backups'

    # Already repaired package is a no-op.
    $CanonicalRoot = Join-Path $TempRoot 'canonical'
    $CanonicalMessaging = New-FakePackage -Root $CanonicalRoot -Layout Canonical
    & $RepairScript -PackageRoot $CanonicalRoot | Out-Null
    Assert-Equal 0 $LASTEXITCODE 'already repaired layout must succeed'
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $CanonicalMessaging -Filter '*.bak.mashirobot-*').Count 'already repaired layout must remain a no-op'

    # Unknown layouts must fail before either file or a backup is touched.
    foreach ($Layout in @('UnknownFast', 'UnknownProcess')) {
        $UnknownRoot = Join-Path $TempRoot $Layout
        $UnknownMessaging = New-FakePackage -Root $UnknownRoot -Layout $Layout
        $OriginalFast = Get-Content -LiteralPath (Join-Path $UnknownMessaging 'fast-routine.js') -Raw -Encoding utf8
        $OriginalProcess = Get-Content -LiteralPath (Join-Path $UnknownMessaging 'process-message.js') -Raw -Encoding utf8
        $ExitCode = Invoke-RepairExpectFailure -PackageRoot $UnknownRoot
        Assert-True ($ExitCode -ne 0) "$Layout must fail"
        Assert-Equal $OriginalFast (Get-Content -LiteralPath (Join-Path $UnknownMessaging 'fast-routine.js') -Raw -Encoding utf8) "$Layout must preserve fast-routine.js"
        Assert-Equal $OriginalProcess (Get-Content -LiteralPath (Join-Path $UnknownMessaging 'process-message.js') -Raw -Encoding utf8) "$Layout must preserve process-message.js"
        Assert-Equal 0 @(Get-ChildItem -LiteralPath $UnknownMessaging -Filter '*.bak.mashirobot-*').Count "$Layout must not create backups"
    }

    # A validation failure after writes must restore both originals.
    $RollbackRoot = Join-Path $TempRoot 'rollback'
    $RollbackMessaging = New-FakePackage -Root $RollbackRoot -Layout KnownOld
    $RollbackFast = Get-Content -LiteralPath (Join-Path $RollbackMessaging 'fast-routine.js') -Raw -Encoding utf8
    $RollbackProcess = Get-Content -LiteralPath (Join-Path $RollbackMessaging 'process-message.js') -Raw -Encoding utf8
    $FailNode = Join-Path $TempRoot 'fail-node.cmd'
    Set-Content -LiteralPath $FailNode -Value "@echo off`r`nexit /b 23`r`n" -Encoding ascii -NoNewline
    $ExitCode = Invoke-RepairExpectFailure -PackageRoot $RollbackRoot -NodePath $FailNode
    Assert-True ($ExitCode -ne 0) 'node validation failure must fail repair'
    Assert-Equal $RollbackFast (Get-Content -LiteralPath (Join-Path $RollbackMessaging 'fast-routine.js') -Raw -Encoding utf8) 'rollback must restore fast-routine.js'
    Assert-Equal $RollbackProcess (Get-Content -LiteralPath (Join-Path $RollbackMessaging 'process-message.js') -Raw -Encoding utf8) 'rollback must restore process-message.js'
    Assert-Equal 2 @(Get-ChildItem -LiteralPath $RollbackMessaging -Filter '*.bak.mashirobot-*').Count 'rollback must retain the two recovery backups'

    $WrapperText = Get-Content -LiteralPath $GatewayWrapper -Raw -Encoding utf8
    Assert-True ($WrapperText -match 'repair-openclaw-adapter\.ps1') 'gateway wrapper must run adapter repair'
    Assert-True ($WrapperText -match 'check-mashirobot\.ps1') 'gateway wrapper must run pre-start health check'
    Assert-True ($WrapperText -match '\-PreStart') 'gateway wrapper must request pre-start health mode'
    Assert-True ($WrapperText -match 'gateway\.vbs') 'gateway wrapper must launch the existing VBS entry'
    Assert-True ($WrapperText -notmatch 'Start-ScheduledTask') 'gateway wrapper must not recursively start the Gateway scheduled task'

    $HealthText = Get-Content -LiteralPath $HealthScript -Raw -Encoding utf8
    Assert-True ($HealthText -match 'Microsoft\\WindowsApps\\pwsh\.exe') 'gateway health must recognize the stable PowerShell app alias'
    Assert-True ($HealthText -match 'Test-Path -LiteralPath \$StablePwshAlias -PathType Leaf') 'gateway health must require the stable alias to exist'

    Write-Output 'PASS: adapter repair, rollback, idempotence, and wrapper tests'
}
finally {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
