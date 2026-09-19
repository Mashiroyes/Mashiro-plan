param(
    [Parameter(Mandatory = $true)][ValidateSet('financial_report','prospectus')][string]$CourseType,
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
$cliPath = Join-Path $RuntimeRoot 'plugin\runtime\cli.mjs'
if (-not (Test-Path -LiteralPath $cliPath)) { $cliPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\cli.mjs' }
$pluginRoot = Split-Path -Parent (Split-Path -Parent $cliPath)
$delivery = Get-FinancialDelivery -Account $WeixinAccount -Target $WeixinTarget
$baseArgs = @('--sqlite-path', $SqlitePath, '--plugin-root', $pluginRoot, '--account-id', $delivery.Account, '--conversation-id', $delivery.Target)
if ($Now) { $baseArgs += @('--now', $Now) }

$claim = $null
try {
    $claim = Invoke-FinancialCli -NodePath $nodePath -CliPath $cliPath -Arguments (@('prepare-delivery', '--course-type', $CourseType) + $baseArgs)
    if ($claim.action -ne 'send') {
        Write-FinancialReportLog -Event 'delivery_skipped' -Data @{ courseType = $CourseType; reason = $claim.action }
        $claim | ConvertTo-Json -Compress -Depth 6
        exit 0
    }
    $message = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$claim.messageBase64))
    $send = Send-FinancialWeixinMessage -Message $message -DryRun:$DryRun
    Invoke-FinancialCli -NodePath $nodePath -CliPath $cliPath -Arguments (@('finish-delivery', '--delivery-id', [string]$claim.deliveryId, '--success', 'true') + $baseArgs) | Out-Null
    Write-FinancialReportLog -Event 'delivery_sent' -Data @{ courseType = $CourseType; lessonNumber = $claim.lessonNumber; dryRun = [bool]$DryRun }
    @{ action = 'sent'; lessonNumber = $claim.lessonNumber; dryRun = [bool]$DryRun; utf8Length = [Text.Encoding]::UTF8.GetByteCount($message) } | ConvertTo-Json -Compress
} catch {
    $errorText = $_.Exception.Message
    if ($claim -and $claim.deliveryId) {
        $error64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($errorText))
        try { Invoke-FinancialCli -NodePath $nodePath -CliPath $cliPath -Arguments (@('finish-delivery', '--delivery-id', [string]$claim.deliveryId, '--success', 'false', '--error-base64', $error64) + $baseArgs) | Out-Null } catch {}
    }
    Write-FinancialReportLog -Event 'delivery_failed' -Data @{ courseType = $CourseType; error = $errorText.Substring(0, [Math]::Min(300, $errorText.Length)) }
    throw
}
