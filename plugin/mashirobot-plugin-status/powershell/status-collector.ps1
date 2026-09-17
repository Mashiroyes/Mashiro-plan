param(
    [ValidateSet('status', 'hardware')]
    [string]$Kind = 'status'
)

$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

function Safe([scriptblock]$Action, $Fallback = $null) { try { & $Action } catch { $Fallback } }
function Bytes([object]$Value) { if ($null -eq $Value) { return 0 }; return [double]$Value }
function Get-EffectiveCpuFrequencyMHz($Processor) {
    $baseMHz = [int](Bytes $Processor.CurrentClockSpeed)
    if ($baseMHz -le 0) { return 0 }
    $effectiveSamples = for ($index = 0; $index -lt 12; $index++) {
        $performance = Safe { Get-CimInstance -Namespace root\cimv2 -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation | Where-Object { $_.Name -eq '_Total' } }
        $percent = [double](Bytes $performance.PercentProcessorPerformance)
        if ($percent -gt 0 -and $percent -le 250) { $baseMHz * $percent / 100 }
        if ($index -lt 11) { Start-Sleep -Milliseconds 250 }
    }
    $peakMHz = [double](@($effectiveSamples | Where-Object { $_ -gt 0 } | Measure-Object -Maximum).Maximum)
    if ($peakMHz -gt 0) { return [int][Math]::Round($peakMHz) }
    return $baseMHz
}

function Start-SafeProbeJob([string]$Name, [scriptblock]$Action) { try { Start-ThreadJob -Name $Name -ScriptBlock $Action } catch { $null } }
function Receive-SafeProbeJob($Job, [string]$Name, [datetime]$Deadline, $Fallback) {
    if ($null -eq $Job) { return [pscustomobject]@{ ok=$false; data=$Fallback; error="$Name 探针无法启动" } }
    try {
        if ($Job.State -ne 'Completed') {
            $remainingSeconds = [Math]::Max(0, [Math]::Ceiling(($Deadline - [DateTime]::UtcNow).TotalSeconds))
            if ($remainingSeconds -gt 0) { $null = Wait-Job -Job $Job -Timeout $remainingSeconds }
        }
        if ($Job.State -ne 'Completed') { Stop-Job -Job $Job -ErrorAction SilentlyContinue; return [pscustomobject]@{ ok=$false; data=$Fallback; error="$Name 探针超时" } }
        $value = Receive-Job -Job $Job -ErrorAction Stop
        if ($null -eq $value) { return [pscustomobject]@{ ok=$false; data=$Fallback; error="$Name 探针没有结果" } }
        [pscustomobject]@{ ok=$true; data=$value; error='' }
    } catch { [pscustomobject]@{ ok=$false; data=$Fallback; error=$_.Exception.Message } }
    finally { Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue }
}

$cpuJob = Start-SafeProbeJob 'cpu-process' {
    $processors=@(Get-CimInstance Win32_Processor -ErrorAction Stop);$processor=$processors|Select-Object -First 1;$base=[int]$processor.CurrentClockSpeed
    $samples=for($i=0;$i-lt 12;$i++){$perf=Get-CimInstance -Namespace root\cimv2 -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction SilentlyContinue|Where-Object Name -eq '_Total';$pct=[double]$perf.PercentProcessorPerformance;if($base-gt 0-and$pct-gt 0-and$pct-le 250){$base*$pct/100};if($i-lt 11){Start-Sleep -Milliseconds 250}}
    $frequency=[double](@($samples|Measure-Object -Maximum).Maximum);if($frequency-le 0){$frequency=$base};$before=@{};foreach($p in @(Get-Process)){try{$before[$p.Id]=[pscustomobject]@{Name=$p.ProcessName;Cpu=[double]$p.TotalProcessorTime.TotalSeconds}}catch{}};Start-Sleep -Milliseconds 250;$private=@{};foreach($row in @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue)){try{if([int]$row.IDProcess-gt 0){$private[[int]$row.IDProcess]=[double]$row.WorkingSetPrivate}}catch{}}
    $rows=foreach($p in @(Get-Process)){try{if($before.ContainsKey($p.Id)-and$private.ContainsKey($p.Id)-and$before[$p.Id].Name-ne'Memory Compression'){[pscustomobject]@{name=[string]$before[$p.Id].Name;cpuPercent=[Math]::Max(0,[Math]::Min(100,(([double]$p.TotalProcessorTime.TotalSeconds-$before[$p.Id].Cpu)/0.25/[Math]::Max(1,[Environment]::ProcessorCount)*100)));memoryBytes=[double]$private[$p.Id]}}}catch{}}
    [pscustomobject]@{cpuLoad=[double](($processors|Measure-Object LoadPercentage -Average).Average);effectiveCpuMHz=[int][Math]::Round($frequency);processes=@($rows)}
}
$networkJob = if($Kind-eq'status'){Start-SafeProbeJob 'network' {
    function P([string]$Name,[string]$Url,[string]$Proxy=''){$h=[Net.Http.HttpClientHandler]::new();if($Proxy){$h.Proxy=[Net.WebProxy]::new($Proxy);$h.UseProxy=$true};$c=[Net.Http.HttpClient]::new($h);$c.Timeout=[TimeSpan]::FromSeconds(4);try{$w=[Diagnostics.Stopwatch]::StartNew();$r=$c.SendAsync([Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Head,"$Url?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"),[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult();$w.Stop();[pscustomobject]@{name=$Name;status=[int]$r.StatusCode;statusText=[string]$r.ReasonPhrase;latencyMs=[Math]::Round($w.Elapsed.TotalMilliseconds,2);error=''}}catch{[pscustomobject]@{name=$Name;status=$null;statusText='';latencyMs=$null;error=$_.Exception.Message}}finally{if($r){$r.Dispose()};$c.Dispose();$h.Dispose()}}
    @((P '百度' 'https://www.baidu.com/favicon.ico'),(P 'Google' 'https://www.google.com/favicon.ico' 'http://127.0.0.1:7897'))
}}else{$null}
$temperatureJob = if($Kind-eq'status'){Start-SafeProbeJob 'temperature' {
    $empty=[ordered]@{cpuCelsius=$null;gpuCelsius=$null;diskCelsius=$null;motherboardCelsius=$null};$cache=Join-Path $env:ProgramData 'MashiroBot\TemperatureMonitor\temperatures.json';$started=Get-Date
    try{Start-ScheduledTask -TaskName 'MashiroBot Temperature Monitor' -ErrorAction Stop;for($i=0;$i-lt 20;$i++){Start-Sleep -Milliseconds 250;if(!(Test-Path -LiteralPath $cache)){continue};$snap=Get-Content -LiteralPath $cache -Raw|ConvertFrom-Json;if([datetime]$snap.capturedAt-lt$started){continue};$s=@($snap.sensors);return [ordered]@{cpuCelsius=@($s|?{$_.hardware-eq'Cpu'-and$_.sensor-notmatch'Distance|Average|Max'-and[double]$_.celsius-gt 0}|%{[double]$_.celsius}|Measure-Object -Maximum).Maximum;gpuCelsius=@($s|?{$_.hardware-match'GpuNvidia|GpuAti|GpuAmd'-and$_.sensor-match'GPU Core|Core'-and$_.sensor-notmatch'Memory|Hot Spot|Junction'-and[double]$_.celsius-gt 0}|%{[double]$_.celsius}|Measure-Object -Maximum).Maximum;diskCelsius=@($s|?{$_.hardware-eq'Storage'-and$_.sensor-notmatch'Warning|Critical'-and[double]$_.celsius-gt 0-and[double]$_.celsius-lt 80}|%{[double]$_.celsius}|Measure-Object -Maximum).Maximum;motherboardCelsius=@($s|?{$_.hardware-match'SuperIO|Motherboard'-and[double]$_.celsius-ge 15-and[double]$_.celsius-le 68}|%{[double]$_.celsius}|Measure-Object -Maximum).Maximum}};return $empty}catch{return $empty}
}}else{$null}
$probeDeadline = [DateTime]::UtcNow.AddSeconds(12)

$osInfo = Safe { Get-CimInstance Win32_OperatingSystem }
$processors = @(Safe { Get-CimInstance Win32_Processor } @())
$processor = $processors | Select-Object -First 1
$totalMemory = [double](Bytes $osInfo.TotalVisibleMemorySize) * 1024
$freeMemory = [double](Bytes $osInfo.FreePhysicalMemory) * 1024

$diskRows = foreach ($disk in @(Safe { Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" } @())) {
    if ([double](Bytes $disk.Size) -gt 0) {
        $volumeName = ([string]$disk.VolumeName).Trim()
        $displayName = if ($volumeName) { '{0} {1}' -f [string]$disk.DeviceID, $volumeName } else { [string]$disk.DeviceID }
        [pscustomobject]@{ name=$displayName; totalBytes=[double]$disk.Size; freeBytes=[double]$disk.FreeSpace }
    }
}

function Probe([string]$Name, [string[]]$Urls, [bool]$UseLocalProxy = $false) {
    $handler = [Net.Http.HttpClientHandler]::new()
    if ($UseLocalProxy) {
        $handler.UseProxy = $true
        $handler.Proxy = [Net.WebProxy]::new('http://127.0.0.1:7897')
    }
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(4)
    try {
        $lastError = ''
        foreach ($baseUrl in $Urls) {
            $request = $null; $response = $null
            try {
                $separator = if ($baseUrl.Contains('?')) { '&' } else { '?' }
                $url = '{0}{1}t={2}' -f $baseUrl, $separator, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Head, $url)
                $request.Headers.CacheControl = [Net.Http.Headers.CacheControlHeaderValue]::new(); $request.Headers.CacheControl.NoCache = $true; $request.Headers.CacheControl.NoStore = $true
                $watch = [Diagnostics.Stopwatch]::StartNew()
                $response = $client.SendAsync($request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
                $watch.Stop()
                if ([int]$response.StatusCode -lt 400) {
                    [pscustomobject]@{ name=$Name; status=[int]$response.StatusCode; statusText=[string]$response.ReasonPhrase; latencyMs=[Math]::Round($watch.Elapsed.TotalMilliseconds, 2); error='' }
                    return
                }
                $lastError = ('HTTP {0}' -f [int]$response.StatusCode)
            } catch { $lastError = $_.Exception.Message } finally { if ($response) { $response.Dispose() }; if ($request) { $request.Dispose() } }
        }
        throw $lastError
    } catch {
        [pscustomobject]@{ name=$Name; status=$null; statusText=''; latencyMs=$null; error=$_.Exception.Message }
    } finally { $client.Dispose(); $handler.Dispose() }
}

function Join-Names($items) { @($items | ForEach-Object { [string]$_.Name } | Where-Object { $_ } | Select-Object -Unique) }

function Get-TemperatureSnapshot {
    $taskName = 'MashiroBot Temperature Monitor'
    $cachePath = Join-Path $env:ProgramData 'MashiroBot\TemperatureMonitor\temperatures.json'
    $startedAt = Get-Date
    try { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch { return [ordered]@{ cpuCelsius=$null; gpuCelsius=$null; diskCelsius=$null; motherboardCelsius=$null } }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            if (-not (Test-Path -LiteralPath $cachePath)) { continue }
            $snapshot = Get-Content -LiteralPath $cachePath -Raw | ConvertFrom-Json
            if ([datetime]$snapshot.capturedAt -lt $startedAt) { continue }
            $sensors = @($snapshot.sensors)
            $cpu = @($sensors | Where-Object { $_.hardware -eq 'Cpu' -and $_.sensor -notmatch 'Distance|Average|Max' -and [double]$_.celsius -gt 0 } | ForEach-Object { [double]$_.celsius } | Measure-Object -Maximum).Maximum
            $gpu = @($sensors | Where-Object { $_.hardware -match 'GpuNvidia|GpuAti|GpuAmd' -and $_.sensor -match 'GPU Core|Core' -and $_.sensor -notmatch 'Memory|Hot Spot|Junction' -and [double]$_.celsius -gt 0 } | ForEach-Object { [double]$_.celsius } | Measure-Object -Maximum).Maximum
            $disk = @($sensors | Where-Object { $_.hardware -eq 'Storage' -and $_.sensor -notmatch 'Warning|Critical' -and [double]$_.celsius -gt 0 -and [double]$_.celsius -lt 80 } | ForEach-Object { [double]$_.celsius } | Measure-Object -Maximum).Maximum
            $board = @($sensors | Where-Object { $_.hardware -match 'SuperIO|Motherboard' -and [double]$_.celsius -ge 15 -and [double]$_.celsius -le 68 } | ForEach-Object { [double]$_.celsius } | Measure-Object -Maximum).Maximum
            return [ordered]@{ cpuCelsius=if($cpu){$cpu}else{$null}; gpuCelsius=if($gpu){$gpu}else{$null}; diskCelsius=if($disk){$disk}else{$null}; motherboardCelsius=if($board){$board}else{$null} }
        } catch {}
    }
    return [ordered]@{ cpuCelsius=$null; gpuCelsius=$null; diskCelsius=$null; motherboardCelsius=$null }
}
function Decode-EdidText($bytes) { -join @($bytes | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) }
function Format-PhysicalDisk($disk) {
    $model = ([string]$disk.Model).Trim(); $size = [double](Bytes $disk.Size)
    if (-not $model -or $size -le 0) { return $null }
    $nominal = if ($size -ge 0.95e12 -and $size -lt 1.5e12) { '1TB' } else { '{0:N0}TB' -f [math]::Round($size / 1e12) }
    $modelWithNominal = if ($model -match '(?i)\b1TB\b') { $model } else { "$model $nominal" }
    '{0}（总容量 {1}GB）' -f $modelWithNominal, [math]::Round($size / 1GB)
}
$cpuProbe = Receive-SafeProbeJob $cpuJob 'CPU' $probeDeadline ([pscustomobject]@{ cpuLoad=0; effectiveCpuMHz=[int](Bytes $processor.CurrentClockSpeed); processes=@() })
$cpuLoad = [double]$cpuProbe.data.cpuLoad
$effectiveCpuMHz = [int]$cpuProbe.data.effectiveCpuMHz
$processRows = @($cpuProbe.data.processes)
$hardware = [ordered]@{
    processor=[string]$processor.Name; motherboard='未检测到'; memory='未检测到'; graphics=@(); monitors=@(); physicalDisks=@(); audio=@(); networkAdapters=@()
    system=('{0} {1}' -f [string]$osInfo.Caption, [string]$osInfo.Version).Trim()
    cpuDetail=('频率 {0} MHz  核心数 {1}  线程数 {2}' -f $effectiveCpuMHz, [int]$processor.NumberOfCores, [int]$processor.NumberOfLogicalProcessors)
    motherboardDetail='未检测到'; gpuDetail='未检测到'; memoryDetail='未检测到'; displayDetail=@()
}

if ($Kind -eq 'hardware') {
    $memoryModules = @(Safe { Get-CimInstance Win32_PhysicalMemory } @())
    $memoryGB = (($memoryModules | ForEach-Object { [double](Bytes $_.Capacity) } | Measure-Object -Sum).Sum / 1GB)
    $memorySpeed = @($memoryModules | ForEach-Object { [int]$_.Speed } | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    $memoryTypeCode = @($memoryModules | ForEach-Object { [int]$_.SMBIOSMemoryType } | Where-Object { $_ -gt 0 } | Select-Object -First 1)
    $memoryType = if ($memoryTypeCode -contains 34) { 'DDR5' } elseif ($memoryTypeCode -contains 26) { 'DDR4' } else { '' }
    $board = Safe { Get-CimInstance Win32_BaseBoard | Select-Object -First 1 }
    $gpus = @(Safe { Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Name -notmatch 'Virtual|Microsoft Basic' } } @())
    $monitors = @(Safe { Get-CimInstance Win32_DesktopMonitor } @())
    $physicalDisks = @(Safe { Get-CimInstance Win32_DiskDrive } @())
    $audio = @(Safe { Get-CimInstance Win32_SoundDevice } @())
    $adapters = @(Safe { Get-CimInstance Win32_NetworkAdapter | Where-Object { $_.PhysicalAdapter -eq $true -and $_.Name -and $_.Name -notmatch 'Virtual|VMware|Teredo' } } @())
    $bios = Safe { Get-CimInstance Win32_BIOS | Select-Object -First 1 }
    $nvidiaLine = Safe { (& nvidia-smi --query-gpu=name,memory.total,clocks.current.graphics,driver_version --format=csv,noheader,nounits 2>$null | Select-Object -First 1) }
    $nvidiaParts = @([string]$nvidiaLine -split ',') | ForEach-Object { $_.Trim() }
    $nvidiaName = if ($nvidiaParts.Count -ge 1) { $nvidiaParts[0] } else { '' }
    $nvidiaMemory = if ($nvidiaParts.Count -ge 2) { [double](Bytes $nvidiaParts[1]) } else { 0 }
    $nvidiaClock = if ($nvidiaParts.Count -ge 3) { [double](Bytes $nvidiaParts[2]) } else { 0 }
    $cudaCores = if ($nvidiaName -match 'RTX 5070 Ti') { 8960 } else { 0 }
    $chipset = if ($board.Product -match 'B850') { 'AMD B850' } elseif ($board.Product -match 'X870') { 'AMD X870' } else { '未检测到' }
    $cpuVoltage = if ([int]$processor.CurrentVoltage -gt 0 -and [int]$processor.CurrentVoltage -lt 128) { [math]::Round(([int]$processor.CurrentVoltage) / 10, 3) } else { 0 }
    $memoryBrands = @($memoryModules | ForEach-Object { [string]$_.Manufacturer } | Where-Object { $_ -and $_ -notmatch 'Unknown|Undefined' } | Select-Object -Unique)
    $boardBrand = if ([string]$board.Manufacturer -match 'Colorful') { '七彩虹' } else { [string]$board.Manufacturer }
    $videoControllers = @(Safe { Get-CimInstance Win32_VideoController } @())
    $edidMonitors = @(Safe { Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID | Where-Object Active } @())
    $edidNames = @($edidMonitors | ForEach-Object { Decode-EdidText $_.UserFriendlyName } | Where-Object { $_ })
    $displayDetails = if ($edidNames -contains 'G27H7Pro') { @('G27H7Pro [惠科 HKC2723]  分辨率 2560×1440  刷新率 144Hz  屏幕尺寸 27.2英寸') } else { @($videoControllers | Where-Object { $_.Name -and $_.Name -notmatch 'Virtual|Microsoft Basic|AMD Radeon' } | ForEach-Object { if ($_.CurrentHorizontalResolution -and $_.CurrentVerticalResolution) { '{0} {1}×{2} {3}Hz' -f $_.Name, $_.CurrentHorizontalResolution, $_.CurrentVerticalResolution, $_.CurrentRefreshRate } }) }
    $hardware = [ordered]@{
        processor=[string]$processor.Name
        motherboard=(([string]$boardBrand + ' ' + [string]$board.Product).Trim())
        memory=("{0:N0}GB{1}{2}" -f $memoryGB, ($(if($memoryType){' '+$memoryType}else{''})), ($(if($memorySpeed.Count){' '+($memorySpeed -join '/')+'MHz'}else{''})))
        graphics=@($gpus | ForEach-Object { if($_.Name){ if($_.Name -match 'NVIDIA' -and $nvidiaMemory -gt 0){ '{0} ({1:N0}GB)' -f $_.Name, ($nvidiaMemory / 1024) } else { '{0} ({1}MB)' -f $_.Name, [math]::Round(([double](Bytes $_.AdapterRAM))/1MB) } } } | Where-Object {$_})
        monitors=@($monitors | ForEach-Object { if($_.Name){[string]$_.Name} } | Where-Object {$_})
        physicalDisks=@($physicalDisks | ForEach-Object { Format-PhysicalDisk $_ } | Where-Object {$_})
        audio=@(Join-Names $audio); networkAdapters=@(Join-Names $adapters)
        system=('{0} {1}' -f [string]$osInfo.Caption, [string]$osInfo.Version).Trim()
        cpuDetail=('频率 {0} MHz  电压 {1} V  核心数 {2}  线程数 {3}' -f $effectiveCpuMHz, $(if($cpuVoltage){$cpuVoltage}else{'未检测到'}), [int]$processor.NumberOfCores, [int]$processor.NumberOfLogicalProcessors)
        motherboardDetail=('品牌 {0}  芯片组 {1}  BIOS {2} {3:yyyy-MM-dd}' -f [string]$board.Manufacturer, $chipset, [string]$bios.SMBIOSBIOSVersion, $bios.ReleaseDate)
        gpuDetail=('CUDA核心 {0}  显存 {1:N0} GB  当前频率 {2:N0} MHz  驱动 {3}' -f $(if($cudaCores){$cudaCores}else{'未检测到'}), ($nvidiaMemory / 1024), $nvidiaClock, $(if($nvidiaParts.Count -ge 4){$nvidiaParts[3]}else{'未检测到'}))
        memoryDetail=('总大小 {0:N0} GB  品牌 {1}  当前频率 {2} MHz ({3})' -f $memoryGB, $(if($memoryBrands){$memoryBrands -join '/'}else{'未检测到'}), $(if($memoryModules.ConfiguredClockSpeed){($memoryModules.ConfiguredClockSpeed | Select-Object -First 1)}else{'未检测到'}), $memoryType)
        displayDetail=@($displayDetails)
    }
}

$emptyTemperatures = [ordered]@{ cpuCelsius=$null; gpuCelsius=$null; diskCelsius=$null; motherboardCelsius=$null }
$temperatureProbe = if ($Kind -eq 'status') { Receive-SafeProbeJob $temperatureJob '温度' $probeDeadline $emptyTemperatures } else { [pscustomobject]@{ok=$true;data=$emptyTemperatures;error=''} }
$networkFallback = @([pscustomobject]@{name='百度';status=$null;statusText='';latencyMs=$null;error='网络探针失败'},[pscustomobject]@{name='Google';status=$null;statusText='';latencyMs=$null;error='网络探针失败'})
$networkProbe = if ($Kind -eq 'status') { Receive-SafeProbeJob $networkJob '网络' $probeDeadline $networkFallback } else { [pscustomobject]@{ok=$true;data=@();error=''} }
$temperatures = $temperatureProbe.data
$networkRows = @($networkProbe.data)
$result = [ordered]@{
    capturedAt=(Get-Date).ToString('o'); hostname=$env:COMPUTERNAME; os=[string]$osInfo.Caption
    uptimeSeconds=if ($osInfo.LastBootUpTime) { ((Get-Date) - [datetime]$osInfo.LastBootUpTime).TotalSeconds } else { 0 }
    cpu=[ordered]@{ usagePercent=[double]$cpuLoad; cores=[int]($processors | Measure-Object -Property NumberOfCores -Sum).Sum; threads=[int]($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum; frequencyMHz=$effectiveCpuMHz; model=[string]$processor.Name }
    memory=[ordered]@{ totalBytes=$totalMemory; freeBytes=$freeMemory }
    disks=@($diskRows); temperatures=$temperatures; networkProbes=$networkRows
    processMemoryKind='private-working-set'; processes=@($processRows)
    hardware=$hardware; probeErrors=[ordered]@{ cpu=$(if($cpuProbe.ok){''}else{$cpuProbe.error}); temperature=$(if($temperatureProbe.ok){''}else{$temperatureProbe.error}); network=$(if($networkProbe.ok){''}else{$networkProbe.error}) }
}
$result | ConvertTo-Json -Depth 10 -Compress
