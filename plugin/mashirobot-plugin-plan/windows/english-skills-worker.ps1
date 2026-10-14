param(
    [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$SqlitePath,
    [string]$Now,
    [ValidateSet('current-month','week','month','year')][string]$PeriodType,
    [string]$JobId = '',
    [int]$JobVersion = 0,
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
$machineModule = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\MashiroBot.MachineConfig.ps1'

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

function Get-DailyTargetMinutes {
    param([string]$FromDate, [string]$ToDate)
    if ($FromDate.Substring(0, 7) -ne $ToDate.Substring(0, 7)) { return $null }
    $state = Invoke-PlannerJson @('get-plugin-state', '--plugin-id', 'mashirobot-plugin-language', '--state-key', ('daily-target:' + $FromDate.Substring(0, 7)))
    $minutes = if ($state.found -and $null -ne $state.value.dailyMinutes) { [int]$state.value.dailyMinutes } else { 0 }
    if ($minutes -gt 0 -and $minutes -le 1440) { return $minutes }
    return $null
}

function Get-DuePeriods {
    param([datetime]$LocalDate, [string]$RequestedPeriodType)
    $today = $LocalDate.Date
    $periods = @()
    $weekday = [int]$today.DayOfWeek
    if ($weekday -eq 0) { $weekday = 7 }
    $thisMonday = $today.AddDays(1 - $weekday)
    if ($RequestedPeriodType -eq 'current-month') {
        $from = [datetime]::new($today.Year, $today.Month, 1)
        $periods += [ordered]@{ periodType = 'month'; periodKey = 'month-to-date:' + $today.ToString('yyyy-MM-dd'); fromDate = $from.ToString('yyyy-MM-dd'); toDate = $today.ToString('yyyy-MM-dd'); granularity = 'day'; label = '本月' }
    }
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
    $body = if ($Summary.inactivityWarning) { [string]$Summary.inactivityWarning } else { '暂无间隔提醒。' }
    if ($Period.periodKey -like 'month-to-date:*') { return '今日英语学习计划：' + [Environment]::NewLine + $body }
    return $body
}

function New-ReviewMessage {
    param([hashtable]$Period, [datetime]$LocalDate)
    if ($Period.periodKey -notlike 'month-to-date:*') { return $null }
    $state = Invoke-PlannerJson @('get-plugin-state', '--plugin-id', 'mashirobot-plugin-language', '--state-key', 'teded-listening:v1')
    $today = $LocalDate.ToString('yyyy-MM-dd')
    $dueVideos = if ($state.found -and $null -ne $state.value.videos) {
        @($state.value.videos | Where-Object { @($_.reviewDates) -contains $today } | Sort-Object { [int]$_.number })
    } else { @() }
    if ($dueVideos.Count -eq 0) {
        '今日无 TED-Ed 复习。'
    } else {
        @('今日 TED-Ed 复习（1.5倍速）：') + @($dueVideos | ForEach-Object { '#{0} {1}' -f [int]$_.number, [string]$_.title }) -join [Environment]::NewLine
    }
}

function Invoke-WeixinSend {
    param(
        [Parameter(Mandatory = $true)]$Delivery,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$MediaPath = ''
    )
    $arguments = @('message', 'send', '--json', '--channel', 'openclaw-weixin', '--account', [string]$Delivery.Account, '--target', [string]$Delivery.Target, '--message', $Message)
    if ($MediaPath) { $arguments += @('--media', $MediaPath) }
    $raw = & $Delivery.OpenClawCommand @arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($raw -join [Environment]::NewLine) }
    try { $result = (($raw -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable) }
    catch { throw ('OpenClaw did not return valid delivery JSON: ' + ($raw -join [Environment]::NewLine)) }
    $messageId = if ($result.result -and $result.result.messageId) { [string]$result.result.messageId } elseif ($result.messageId) { [string]$result.messageId } else { '' }
    if ([string]$result.deliveryStatus -ne 'sent' -or -not $messageId) {
        throw ('WeChat delivery was not verified: ' + ($result | ConvertTo-Json -Compress -Depth 8))
    }
    return [ordered]@{ deliveryStatus = [string]$result.deliveryStatus; messageId = $messageId }
}

$localNow = if ($Now) { [DateTimeOffset]::Parse($Now).ToOffset([TimeSpan]::FromHours(8)).DateTime } else { [DateTimeOffset]::Now.ToOffset([TimeSpan]::FromHours(8)).DateTime }
$due = @(Get-DuePeriods $localNow $PeriodType)
$results = @()
$runtimeRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$controlCli = Join-Path $runtimeRoot 'core\control\reminder-cli.mjs'
$jobCli = Join-Path $runtimeRoot 'core\control\job-cli.mjs'
function Invoke-ControlReminder([string]$action,[hashtable]$payload){$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Compress -Depth 8)));$raw=& node $controlCli $action $env:OPENCLAW_PLANNER_DB_PATH $encoded 2>&1;if($LASTEXITCODE-ne 0){throw($raw-join[Environment]::NewLine)};(($raw-join'')|ConvertFrom-Json)}
function Invoke-ControlJob([string]$action,[hashtable]$payload){$encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload|ConvertTo-Json -Compress -Depth 8)));$raw=& node $jobCli $action $SqlitePath $encoded 2>&1;if($LASTEXITCODE-ne 0){throw($raw-join[Environment]::NewLine)};(($raw-join'')|ConvertFrom-Json)}
$jobClaimed = $false
if ($JobId -and -not $DryRun) {
    $jobClaim = Invoke-ControlJob 'claim' @{jobId=$JobId;version=$JobVersion}
    if (-not [bool]$jobClaim.claimed) { [ordered]@{ok=$true;action='skip';reason='stale-or-inactive-job';jobId=$JobId;version=$JobVersion}|ConvertTo-Json; exit 0 }
    $jobClaimed = $true
}
foreach ($period in $due) {
    $claim = $null
    $managed = $null
    if (-not $DryRun) {
        $claim = Invoke-PlannerJson @('claim-english-skill-delivery', '--payload-base64', (ConvertTo-Base64Json $period))
        if (-not $claim.shouldSend) {
            $results += [ordered]@{ periodKey = $period.periodKey; action = 'skip'; reason = $claim.reason }
            continue
        }
    }
    try {
        $summary = Invoke-PlannerJson @('query-english-skills', '--from', $period.fromDate, '--to', $period.toDate, '--granularity', $period.granularity)
        if ($period.periodType -eq 'month') {
            $dailyTarget = Get-DailyTargetMinutes -FromDate $period.fromDate -ToDate $period.toDate
            if ($null -ne $dailyTarget) { $summary.dailyTargetMinutes = $dailyTarget }
        }
        $chartDir = Join-Path $env:TEMP 'MashiroBot\english-skills'
        [IO.Directory]::CreateDirectory($chartDir) | Out-Null
        $chartPath = Join-Path $chartDir ($period.periodKey.Replace(':', '-') + '-' + [guid]::NewGuid().ToString('N') + '.png')
        $encoded = ConvertTo-Base64Json $summary
        $null = Invoke-PlannerJson @('english-skills-chart', '--payload-base64', $encoded, '--output', $chartPath)
        $message = New-ReportMessage $period $summary
        $reviewMessage = New-ReviewMessage $period $localNow
        $planDelivery = $null
        $reviewDelivery = $null
        $chartDelivery = $null
        $chartError = $null
        if (-not $DryRun) {
            if (-not (Test-Path -LiteralPath $machineModule -PathType Leaf)) { throw "MashiroBot machine configuration helper is missing: $machineModule" }
            Import-Module $machineModule -Force
            $delivery = Resolve-MashiroWeixinDelivery

            if ($reviewMessage) {
                $managed = Invoke-ControlReminder 'dispatch' @{sourcePlugin='mashirobot-plugin-language';kind='learning-plan';priority=1;content=$message;requiresAck=$false;dedupeKey=("english-plan:"+$period.periodKey);sourceRef=$period.periodKey;dueAt=[DateTimeOffset]::UtcNow.ToString('o')}
                if(-not[bool]$managed.shouldSend){throw ('English learning-plan reminder was suppressed: ' + [string]$managed.reason)}
                $planDelivery = Invoke-WeixinSend -Delivery $delivery -Message ([string]$managed.message)
                [void](Invoke-ControlReminder 'finish' @{reminderIds=@($managed.reminderIds);ok=$true})
                $managed = $null

                $managed = Invoke-ControlReminder 'dispatch' @{sourcePlugin='mashirobot-plugin-language';kind='teded-review';priority=1;content=$reviewMessage;requiresAck=$false;dedupeKey=("teded:"+$localNow.ToString('yyyy-MM-dd'));sourceRef=$localNow.ToString('yyyy-MM-dd');dueAt=[DateTimeOffset]::UtcNow.ToString('o')}
                if(-not[bool]$managed.shouldSend){throw ('TED-Ed review reminder was suppressed: ' + [string]$managed.reason)}
                $reviewDelivery = Invoke-WeixinSend -Delivery $delivery -Message ([string]$managed.message)
                [void](Invoke-ControlReminder 'finish' @{reminderIds=@($managed.reminderIds);ok=$true})
                $managed = $null

                try { $chartDelivery = Invoke-WeixinSend -Delivery $delivery -Message '本月英语学习统计图。' -MediaPath $chartPath }
                catch { $chartError = $_.Exception.Message }
            } else {
                $managed = Invoke-ControlReminder 'dispatch' @{sourcePlugin='mashirobot-plugin-language';kind='statistics';priority=1;content=$message;requiresAck=$false;dedupeKey=("english:"+$period.periodKey);sourceRef=$period.periodKey;dueAt=[DateTimeOffset]::UtcNow.ToString('o')}
                if(-not[bool]$managed.shouldSend){throw ('English statistics reminder was suppressed: ' + [string]$managed.reason)}
                $chartDelivery = Invoke-WeixinSend -Delivery $delivery -Message ([string]$managed.message) -MediaPath $chartPath
                [void](Invoke-ControlReminder 'finish' @{reminderIds=@($managed.reminderIds);ok=$true})
                $managed = $null
            }
            $null = Invoke-PlannerJson @('finish-english-skill-delivery', '--period-key', $period.periodKey, '--status', 'sent')
        }
        $results += [ordered]@{ periodKey = $period.periodKey; action = if ($DryRun) { 'dry-run' } else { 'sent' }; fromDate = $period.fromDate; toDate = $period.toDate; mediaPath = $chartPath; message = $message; reviewMessage = $reviewMessage; planDelivery = $planDelivery; reviewDelivery = $reviewDelivery; chartDelivery = $chartDelivery; chartError = $chartError }
    } catch {
        if($managed -and $managed.reminderIds){try{[void](Invoke-ControlReminder 'finish' @{reminderIds=@($managed.reminderIds);ok=$false;error=$_.Exception.Message})}catch{}}
        if (-not $DryRun -and $claim -and $claim.shouldSend) {
            $null = Invoke-PlannerJson @('finish-english-skill-delivery', '--period-key', $period.periodKey, '--status', 'failed', '--error', $_.Exception.Message)
        }
        $results += [ordered]@{ periodKey = $period.periodKey; action = 'failed'; error = $_.Exception.Message }
    }
}

$ok = -not (@($results | Where-Object action -eq 'failed').Count)
if ($jobClaimed) { [void](Invoke-ControlJob 'complete' @{jobId=$JobId;version=$JobVersion;ok=$ok;recurring=$true;error=if($ok){$null}else{'one or more English skill deliveries failed'}}) }
[ordered]@{ ok = $ok; now = $localNow.ToString('yyyy-MM-ddTHH:mm:sszzz'); duePeriods = $due; results = $results; dryRun = [bool]$DryRun } | ConvertTo-Json -Depth 10
