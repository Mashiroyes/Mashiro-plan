Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'reminder-common.ps1')

function Get-ShanghaiNow {
    return [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId(
        [DateTimeOffset]::UtcNow,
        'China Standard Time'
    )
}

function Get-NightRoutineDate {
    param([Parameter(Mandatory = $true)][DateTimeOffset]$Now)

    $date = if ($Now.Hour -lt 6) { $Now.AddDays(-1) } else { $Now }
    return $date.ToString('yyyy-MM-dd')
}

function Read-RoutineState {
    param([string]$RoutineDate)

    if (-not $RoutineDate) { $RoutineDate = Get-NightRoutineDate -Now (Get-ShanghaiNow) }
    return Get-PlanPluginState -StateKey ('night:{0}' -f $RoutineDate)
}

function Write-RoutineState {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$State)

    $routineDate = [string]$State.routineDate
    if ([string]::IsNullOrWhiteSpace($routineDate)) { throw 'Routine state is missing routineDate.' }
    Set-PlanPluginState -StateKey ('night:{0}' -f $routineDate) -State $State
}

function New-RoutineState {
    param([Parameter(Mandatory = $true)][DateTimeOffset]$Now)

    return @{
        routineDate = Get-NightRoutineDate -Now $Now
        wordChecked = $false
        slept = $false
        updatedAt = $Now.ToString('o')
    }
}
