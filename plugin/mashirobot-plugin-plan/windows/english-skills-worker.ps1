param(
    [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$SqlitePath,
    [string]$Now,
    [ValidateSet('week','month','year')][string]$PeriodType,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$PluginRoot = [IO.Path]::GetFullPath($PluginRoot)
if (-not $SqlitePath) {
    $planRoot = Split-Path -Parent (Split-Path -Parent $PluginRoot)
    $SqlitePath = Join-Path $planRoot 'sqlite\openclaw-planner.sqlite'
}
$SqlitePath = [IO.Path]::GetFullPath($SqlitePath)
$planner = Join-Path $PluginRoot 'planner\planner.py'
$python = (Get-Command python.exe -ErrorAction Stop).Source
$openClaw = 'D:\Program\nodejs\npm_global24\openclaw.ps1'
$account = 'ea8fd13b2100-im-bot'
$target = 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat'

function Invoke-PlannerJson {
    param([string[]]$Arguments)
    $env:PYTHONUTF8 = '1'
    $env:OPENCLAW_PLANNER_DB_PATH = $SqlitePath
    $raw = & $python $planner @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($raw -join [Environment]::NewLine) }
    return (($raw -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable)
}

function ConvertTo-Base64Json {
    param([hashtable]$Value)
    $json = $Value | ConvertTo-Json -Compress -Depth 8
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
}

function Get-DuePeriods {
    param([datetime]$LocalDate, [string]$RequestedPeriodType)
    $today = $LocalDate.Date
    $periods = @()
    $weekday = [int]$today.DayOfWeek
    if ($weekday -eq 0) { $weekday = 7 }
    $thisMonday = $today.AddDays(1 - $weekday)
    if ($RequestedPeriodType -eq 'week' -or (-not $RequestedPeriodType -and $today.DayOfWeek -eq [DayOfWeek]::Monday)) {
        $from = $thisMonday.AddDays(-7)
        $periods += [ordered]@{ periodType = 'week'; periodKey = 'week:' + $from.ToString('yyyy-MM-dd'); fromDate = $from.ToString('yyyy-MM-dd'); toDate = $today.AddDays(-1).ToString('yyyy-MM-dd'); granularity = 'day'; label = '上周' }
        $periods[-1].toDate = $from.AddDays(6).ToString('yyyy-MM-dd')
    }
    if ($RequestedPeriodType -eq 'month' -or (-not $RequestedPeriodType -and $today.Day -eq 1)) {
        $end = ([datetime]::new($today.Year, $today.Month, 1)).AddDays(-1)
        $from = [datetime]::new($end.Year, $end.Month, 1)
        $periods += [ordered]@{ periodType = 'month'; periodKey = 'month:' + $from.ToString('yyyy-MM'); fromDate = $from.ToString('yyyy-MM-dd'); toDate = $end.ToString('yyyy-MM-dd'); granularity = 'day'; label = '上个月' }
    }
    if ($RequestedPeriodType -eq 'year' -or (-not $RequestedPeriodType -and $today.Month -eq 1 -and $today.Day -eq 1)) {
        $year = $today.Year - 1
        $periods += [ordered]@{ periodType = 'year'; periodKey = 'year:' + $year; fromDate = "$year-01-01"; toDate = "$year-12-31"; granularity = 'month'; label = '去年' }
    }
    return @($periods)
}

function Format-Duration([int]$Minutes) {
    $hours = [Math]::Floor($Minutes / 60)
    $rest = $Minutes % 60
    if ($hours -eq 0) { return "$rest 分钟" }
    if ($rest -eq 0) { return "$hours 小时" }
    return "$hours 小时 $rest 分钟"
}

function New-ReportMessage {
    param([hashtable]$Period, [hashtable]$Summary)
    $labels = [ordered]@{ listening = '听'; speaking = '说'; reading = '读'; writing = '写' }
    $lines = @("$($Period.label)英语听说读写统计（$($Period.fromDate) 至 $($Period.toDate)）：")
    foreach ($skill in $labels.Keys) {
        $minutes = [int]$Summary.totals[$skill]
        $percent = [double]$Summary.percentages[$skill]
        $lines += ('{0}：{1}（{2:N1}%）' -f $labels[$skill], (Format-Duration $minutes), $percent)
    }
    $lines += 'Anki：' + (Format-Duration ([int]$Summary.totals.anki)) + '（不计入四项占比）'
    if ($Summary.warning) { $lines += [string]$Summary.warning }
    return ($lines -join [Environment]::NewLine)
}

$localNow = if ($Now) { [DateTimeOffset]::Parse($Now).ToOffset([TimeSpan]::FromHours(8)).DateTime } else { [DateTimeOffset]::Now.ToOffset([TimeSpan]::FromHours(8)).DateTime }
$due = @(Get-DuePeriods $localNow $PeriodType)
$results = @()
foreach ($period in $due) {
    $claim = $null
    if (-not $DryRun) {
        $claim = Invoke-PlannerJson @('claim-english-skill-delivery', '--payload-base64', (ConvertTo-Base64Json $period))
        if (-not $claim.shouldSend) {
            $results += [ordered]@{ periodKey = $period.periodKey; action = 'skip'; reason = $claim.reason }
            continue
        }
    }
    try {
        $summary = Invoke-PlannerJson @('query-english-skills', '--from', $period.fromDate, '--to', $period.toDate, '--granularity', $period.granularity)
        $chartDir = Join-Path $env:TEMP 'MashiroBot\english-skills'
        [IO.Directory]::CreateDirectory($chartDir) | Out-Null
        $chartPath = Join-Path $chartDir ($period.periodKey.Replace(':', '-') + '-' + [guid]::NewGuid().ToString('N') + '.png')
        $encoded = ConvertTo-Base64Json $summary
        $null = Invoke-PlannerJson @('english-skills-chart', '--payload-base64', $encoded, '--output', $chartPath)
        $message = New-ReportMessage $period $summary
        if (-not $DryRun) {
            $sendOutput = & $openClaw message send --json --channel 'openclaw-weixin' --account $account --target $target --message $message --media $chartPath 2>&1
            if ($LASTEXITCODE -ne 0) { throw ($sendOutput -join [Environment]::NewLine) }
            $null = Invoke-PlannerJson @('finish-english-skill-delivery', '--period-key', $period.periodKey, '--status', 'sent')
        }
        $results += [ordered]@{ periodKey = $period.periodKey; action = if ($DryRun) { 'dry-run' } else { 'sent' }; fromDate = $period.fromDate; toDate = $period.toDate; mediaPath = $chartPath; message = $message }
    } catch {
        if (-not $DryRun -and $claim -and $claim.shouldSend) {
            $null = Invoke-PlannerJson @('finish-english-skill-delivery', '--period-key', $period.periodKey, '--status', 'failed', '--error', $_.Exception.Message)
        }
        $results += [ordered]@{ periodKey = $period.periodKey; action = 'failed'; error = $_.Exception.Message }
    }
}

[ordered]@{ ok = -not (@($results | Where-Object action -eq 'failed').Count); now = $localNow.ToString('yyyy-MM-ddTHH:mm:sszzz'); duePeriods = $due; results = $results; dryRun = [bool]$DryRun } | ConvertTo-Json -Depth 10
