[CmdletBinding()]
param(
    [string]$PackageRoot,
    [switch]$WhatIfReport,
    [string]$NodePath = 'node'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AdapterRoot = $PSScriptRoot
$CanonicalAdapterPath = Join-Path $AdapterRoot 'fast-routine.adapter.js'
$FastRelativePath = 'dist\src\messaging\fast-routine.js'
$ProcessRelativePath = 'dist\src\messaging\process-message.js'

function Resolve-OpenClawPackageRoot {
    param([string]$ExplicitRoot)

    if ($ExplicitRoot) {
        $Resolved = [System.IO.Path]::GetFullPath($ExplicitRoot)
        if (-not (Test-Path -LiteralPath $Resolved -PathType Container)) {
            throw "OpenClaw package root does not exist: $Resolved"
        }
        return $Resolved
    }

    $ProjectsRoot = Join-Path $env:USERPROFILE '.openclaw\npm\projects'
    if (-not (Test-Path -LiteralPath $ProjectsRoot -PathType Container)) {
        throw "OpenClaw projects root does not exist: $ProjectsRoot"
    }

    $Candidates = @(
        Get-ChildItem -LiteralPath $ProjectsRoot -Directory -Filter 'tencent-weixin-openclaw-weixin-*' |
            ForEach-Object {
                Join-Path $_.FullName 'node_modules\@tencent-weixin\openclaw-weixin'
            } |
            Where-Object {
                (Test-Path -LiteralPath (Join-Path $_ $FastRelativePath) -PathType Leaf) -and
                (Test-Path -LiteralPath (Join-Path $_ $ProcessRelativePath) -PathType Leaf)
            }
    )

    if ($Candidates.Count -ne 1) {
        throw "Expected exactly one active Tencent Weixin OpenClaw package, found $($Candidates.Count)."
    }
    return [System.IO.Path]::GetFullPath($Candidates[0])
}

function Get-ProcessCallState {
    param([string]$Text)

    $ImportPattern = '(?m)^\s*import\s*\{\s*handleFastRoutineCommand\s*\}\s*from\s*["'']\.\/fast-routine\.js["''];\s*$'
    if ([regex]::Matches($Text, $ImportPattern).Count -ne 1) {
        throw 'Unknown process-message.js layout: expected one fast-routine import marker.'
    }

    $OldPattern = '(?m)^(?<indent>[ \t]*)const\s+fastRoutineResult\s*=\s*handleFastRoutineCommand\(rawBody\);[ \t]*$'
    $SyncContextPattern = '(?ms)^(?<indent>[ \t]*)const\s+fastRoutineResult\s*=\s*handleFastRoutineCommand\(\s*rawBody\s*,\s*\{\s*accountId\s*:\s*deps\.accountId\s*,\s*conversationId\s*:\s*full\.from_user_id\s*\?\?\s*ctx\.To\s*\?\?\s*["'']["'']\s*,\s*now\s*:\s*new Date\(\)\s*,?\s*\}\s*\);[ \t]*$'
    $NewPattern = '(?ms)^(?<indent>[ \t]*)const\s+fastRoutineResult\s*=\s*await\s+handleFastRoutineCommand\(\s*rawBody\s*,\s*\{\s*accountId\s*:\s*deps\.accountId\s*,\s*conversationId\s*:\s*full\.from_user_id\s*\?\?\s*ctx\.To\s*\?\?\s*["'']["'']\s*,\s*now\s*:\s*new Date\(\)\s*,?\s*\}\s*\);[ \t]*$'
    $OldMatches = [regex]::Matches($Text, $OldPattern)
    $SyncContextMatches = [regex]::Matches($Text, $SyncContextPattern)
    $NewMatches = [regex]::Matches($Text, $NewPattern)

    if ($OldMatches.Count -eq 1 -and $SyncContextMatches.Count -eq 0 -and $NewMatches.Count -eq 0) {
        return [pscustomobject]@{ State = 'KnownOld'; Pattern = $OldPattern; Match = $OldMatches[0] }
    }
    if ($OldMatches.Count -eq 0 -and $SyncContextMatches.Count -eq 1 -and $NewMatches.Count -eq 0) {
        return [pscustomobject]@{ State = 'KnownSyncContext'; Pattern = $SyncContextPattern; Match = $SyncContextMatches[0] }
    }
    if ($OldMatches.Count -eq 0 -and $SyncContextMatches.Count -eq 0 -and $NewMatches.Count -eq 1) {
        return [pscustomobject]@{ State = 'Canonical'; Pattern = $NewPattern; Match = $NewMatches[0] }
    }
    throw "Unknown process-message.js layout: old call markers=$($OldMatches.Count), sync-context markers=$($SyncContextMatches.Count), canonical call markers=$($NewMatches.Count)."
}

function Get-FastAdapterState {
    param([string]$Text, [string]$CanonicalText)

    if ($Text -eq $CanonicalText) { return 'Canonical' }

    $HasKnownExport = $Text -match '(?m)^\s*export\s+function\s+handleFastRoutineCommand\s*\('
    $HasKnownBridge = $Text -match 'plan/script/bridge/openclaw-router\.mjs'
    if ($HasKnownExport -and $HasKnownBridge) { return 'KnownOld' }

    throw 'Unknown fast-routine.js layout: neither canonical adapter nor known legacy markers were found.'
}

function New-CanonicalProcessText {
    param([string]$Text, $CallState)

    if ($CallState.State -eq 'Canonical') { return $Text }
    $Indent = $CallState.Match.Groups['indent'].Value
    $Replacement = @(
        "${Indent}const fastRoutineResult = await handleFastRoutineCommand(rawBody, {"
        "${Indent}    accountId: deps.accountId,"
        ($Indent + '    conversationId: full.from_user_id ?? ctx.To ?? "",')
        "${Indent}    now: new Date(),"
        "${Indent}});"
    ) -join "`n"
    return [regex]::Replace($Text, $CallState.Pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($Match) $Replacement }, 1)
}

function Invoke-NodeCheck {
    param([string]$FilePath)
    & $NodePath --check $FilePath
    if ($LASTEXITCODE -ne 0) {
        throw "node --check failed for $FilePath with exit code $LASTEXITCODE"
    }
}

try {
    if (-not (Test-Path -LiteralPath $CanonicalAdapterPath -PathType Leaf)) {
        throw "Canonical adapter is missing: $CanonicalAdapterPath"
    }

    $ResolvedPackageRoot = Resolve-OpenClawPackageRoot -ExplicitRoot $PackageRoot
    $FastPath = Join-Path $ResolvedPackageRoot $FastRelativePath
    $ProcessPath = Join-Path $ResolvedPackageRoot $ProcessRelativePath
    foreach ($Path in @($FastPath, $ProcessPath)) {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw "Required OpenClaw entry is missing: $Path"
        }
    }

    $CanonicalText = Get-Content -LiteralPath $CanonicalAdapterPath -Raw -Encoding utf8
    $FastText = Get-Content -LiteralPath $FastPath -Raw -Encoding utf8
    $ProcessText = Get-Content -LiteralPath $ProcessPath -Raw -Encoding utf8
    $FastState = Get-FastAdapterState -Text $FastText -CanonicalText $CanonicalText
    $ProcessState = Get-ProcessCallState -Text $ProcessText
    $NewProcessText = New-CanonicalProcessText -Text $ProcessText -CallState $ProcessState

    $NeedsFastWrite = $FastState -ne 'Canonical'
    $NeedsProcessWrite = $ProcessState.State -ne 'Canonical'

    if ($WhatIfReport) {
        Write-Output "PackageRoot: $ResolvedPackageRoot"
        Write-Output "Target: $FastPath | state=$FastState | action=$(if ($NeedsFastWrite) { 'replace full file with canonical adapter' } else { 'no change' })"
        Write-Output "Target: $ProcessPath | state=$($ProcessState.State) | action=$(if ($NeedsProcessWrite) { 'replace fast-handler call only' } else { 'no change' })"
        exit 0
    }

    if (-not $NeedsFastWrite -and -not $NeedsProcessWrite) {
        Write-Output "MashiroBot OpenClaw adapter is already canonical: $ResolvedPackageRoot"
        exit 0
    }

    $Stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    $FastBackup = "$FastPath.bak.mashirobot-$Stamp"
    $ProcessBackup = "$ProcessPath.bak.mashirobot-$Stamp"
    Copy-Item -LiteralPath $FastPath -Destination $FastBackup -ErrorAction Stop
    Copy-Item -LiteralPath $ProcessPath -Destination $ProcessBackup -ErrorAction Stop

    try {
        if ($NeedsFastWrite) {
            Set-Content -LiteralPath $FastPath -Value $CanonicalText -Encoding utf8 -NoNewline
        }
        if ($NeedsProcessWrite) {
            Set-Content -LiteralPath $ProcessPath -Value $NewProcessText -Encoding utf8 -NoNewline
        }
        Invoke-NodeCheck -FilePath $FastPath
        Invoke-NodeCheck -FilePath $ProcessPath
    }
    catch {
        Copy-Item -LiteralPath $FastBackup -Destination $FastPath -Force
        Copy-Item -LiteralPath $ProcessBackup -Destination $ProcessPath -Force
        throw "Adapter validation failed and both OpenClaw entries were restored. $($_.Exception.Message)"
    }

    Write-Output "MashiroBot OpenClaw adapter repaired: $ResolvedPackageRoot"
    Write-Output "Backup: $FastBackup"
    Write-Output "Backup: $ProcessBackup"
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
