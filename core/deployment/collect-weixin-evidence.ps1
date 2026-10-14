[CmdletBinding()]
param(
    [Parameter(Mandatory)][datetimeoffset]$Since,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$MashiroBotLogPath = (Join-Path $env:USERPROFILE '.openclaw\logs\mashirobot.log'),
    [string]$GatewayLogDirectory = (Join-Path $env:LOCALAPPDATA 'Temp\openclaw')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

$expected = @(
    [pscustomobject]@{ command='帮助'; localCommand='帮助菜单'; routeId='mashirobot-core/help'; pluginId='mashirobot-core'; replyClass='media' },
    [pscustomobject]@{ command='状态'; localCommand='状态'; routeId='mashirobot-plugin-status/status'; pluginId='mashirobot-plugin-status'; replyClass='media' },
    [pscustomobject]@{ command='查询今日计划'; localCommand='查询计划'; routeId='mashirobot-plugin-plan/query-plan'; pluginId='mashirobot-plugin-plan'; replyClass='text' }
)

function Read-JsonLines([string[]]$Paths) {
    foreach ($path in $Paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { $line | ConvertFrom-Json } catch { continue }
        }
    }
}

$routeEvents = @(Read-JsonLines @($MashiroBotLogPath) | Where-Object {
    $_.PSObject.Properties['event'] -and $_.PSObject.Properties['timestamp'] -and
    $_.event -eq 'route_completed' -and [datetimeoffset]$_.timestamp -ge $Since
})
$gatewayPaths = if (Test-Path -LiteralPath $GatewayLogDirectory -PathType Container) {
    @(Get-ChildItem -LiteralPath $GatewayLogDirectory -File -Filter 'openclaw-*.log' |
        Where-Object { $_.LastWriteTimeUtc -ge $Since.UtcDateTime.AddMinutes(-2) } |
        Select-Object -ExpandProperty FullName)
} else { @() }
$gatewayEvents = @(Read-JsonLines $gatewayPaths | Where-Object {
    $_.PSObject.Properties['time'] -and $_.PSObject.Properties['1'] -and
    [datetimeoffset]$_.time -ge $Since -and [string]$_.'1' -match 'Fast routine command handled command='
})

$evidence = foreach ($item in $expected) {
    $route = @($routeEvents | Where-Object {
        $_.pluginId -eq $item.pluginId -and $_.message -eq $item.localCommand
    } | Sort-Object { [datetimeoffset]$_.timestamp } -Descending | Select-Object -First 1)
    if (-not $route) { continue }
    $routeTime = [datetimeoffset]$route[0].timestamp
    $gateway = @($gatewayEvents | Where-Object {
        [string]$_.'1' -match ('command=' + [regex]::Escape($item.localCommand) + '(?:,|$)') -and
        [math]::Abs((([datetimeoffset]$_.time) - $routeTime).TotalSeconds) -le 90
    } | Sort-Object { [datetimeoffset]$_.time } | Select-Object -First 1)
    if (-not $gateway) { continue }
    [ordered]@{
        command = $item.command
        routeId = $item.routeId
        replyClass = $item.replyClass
        timestamp = $routeTime.ToString('o')
        gatewayLogMatched = $true
    }
}

New-Item -ItemType Directory -Path (Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))) -Force | Out-Null
$evidence | ConvertTo-Json -Depth 5 -AsArray | Set-Content -LiteralPath $OutputPath -Encoding UTF8
$evidence | ConvertTo-Json -Depth 5 -AsArray
