param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$SqlitePath,
    [string]$WeixinAccount,
    [string]$WeixinTarget,
    [string]$Now,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
. (Join-Path $PSScriptRoot 'common.ps1')

$nodePath = Join-Path $RuntimeRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$pluginRoot = Join-Path $RuntimeRoot 'plugin'
if (-not (Test-Path -LiteralPath $pluginRoot)) { $pluginRoot = Split-Path -Parent $PSScriptRoot }
$cliPath = Join-Path $pluginRoot 'runtime\cli.mjs'
$chatPath = Join-Path $pluginRoot 'runtime\chat-feedback.mjs'
$delivery = Get-FinancialDelivery -Account $WeixinAccount -Target $WeixinTarget
$baseArgs = @('--sqlite-path', $SqlitePath, '--plugin-root', $pluginRoot, '--account-id', $delivery.Account, '--conversation-id', $delivery.Target)
if ($Now) { $baseArgs += @('--now', $Now) }

$claim = Invoke-FinancialCli -NodePath $nodePath -CliPath $cliPath -Arguments (@('claim-feedback') + $baseArgs)
if (-not $claim.feedback) {
    Write-FinancialReportLog -Event 'feedback_skipped' -Data @{ reason = 'none_pending' }
    @{ action = 'none_pending' } | ConvertTo-Json -Compress
    exit 0
}

$feedback = $claim.feedback
try {
    if ($DryRun) {
        $sample = "【你答对了什么】已抓住题目重点。`n【还缺什么】还可以补充期间和单位。`n【更好的理解】财报数字要和业务、现金流一起看。`n【下一步】用10分钟复核原文页码。`n仅用于财报学习，不构成投资建议。"
        $generated = @{ ok = $true; outputBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sample)) }
    } else {
        $sessionKey = 'agent:main:financial-report-feedback:' + [string]$feedback.id
        $raw = & $nodePath --no-deprecation $chatPath --plugin-root $pluginRoot --course-type $feedback.course_type `
            --lesson-number ([string]$feedback.lesson_number) --answer-base64 $feedback.answerTextBase64 `
            --openclaw-path $delivery.OpenClawCommand --session-key $sessionKey --timeout-seconds 120 2>&1
        if ($LASTEXITCODE -ne 0) { throw ($raw -join [Environment]::NewLine) }
        $jsonLine = @($raw | ForEach-Object { [string]$_ } | Where-Object { $_.TrimStart().StartsWith('{') })[-1]
        if (-not $jsonLine) { throw 'Chat feedback runner returned no JSON object.' }
        $generated = $jsonLine | ConvertFrom-Json -AsHashtable
    }
    $message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$generated.outputBase64))
    Send-FinancialWeixinMessage -Message $message -DryRun:$DryRun | Out-Null
    Invoke-FinancialCli -NodePath $nodePath -CliPath $cliPath -Arguments (@('finish-feedback', '--feedback-id', [string]$feedback.id, '--output-base64', $generated.outputBase64, '--sent', 'true') + $baseArgs) | Out-Null
    Write-FinancialReportLog -Event 'feedback_sent' -Data @{ feedbackId = $feedback.id; courseType = $feedback.course_type; lessonNumber = $feedback.lesson_number; dryRun = [bool]$DryRun }
    @{ action = 'sent'; feedbackId = $feedback.id; mode = 'chat'; dryRun = [bool]$DryRun } | ConvertTo-Json -Compress
} catch {
    $errorText = $_.Exception.Message
    $error64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($errorText))
    try { Invoke-FinancialCli -NodePath $nodePath -CliPath $cliPath -Arguments (@('fail-feedback', '--feedback-id', [string]$feedback.id, '--error-base64', $error64) + $baseArgs) | Out-Null } catch {}
    Write-FinancialReportLog -Event 'feedback_failed' -Data @{ feedbackId = $feedback.id; error = $errorText.Substring(0, [Math]::Min(300, $errorText.Length)) }
    throw
}
