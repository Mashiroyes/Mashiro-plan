param(
    [Parameter(Mandatory = $true)][string]$LibraryDirectory,
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $LibraryDirectory

try {
    foreach ($dll in @(Get-ChildItem -LiteralPath $LibraryDirectory -Filter '*.dll')) {
        try { [Reflection.Assembly]::LoadFrom($dll.FullName) | Out-Null } catch {}
    }
    $lhm = Join-Path $LibraryDirectory 'LibreHardwareMonitorLib.dll'
    $asm = [Reflection.Assembly]::LoadFrom($lhm)
    $computer = [Activator]::CreateInstance($asm.GetType('LibreHardwareMonitor.Hardware.Computer', $true))
    $computer.IsCpuEnabled = $true
    $computer.IsGpuEnabled = $true
    $computer.IsMemoryEnabled = $true
    $computer.IsMotherboardEnabled = $true
    $computer.IsStorageEnabled = $true
    $computer.IsNetworkEnabled = $false
    $computer.IsBatteryEnabled = $false
    $computer.IsControllerEnabled = $false
    $computer.Open()
    Start-Sleep -Milliseconds 1200
    $rows = New-Object System.Collections.Generic.List[object]
    function Walk($hardware) {
        try { $hardware.Update() } catch {}
        foreach ($sensor in @($hardware.Sensors)) {
            if ($sensor.SensorType.ToString() -eq 'Temperature' -and $null -ne $sensor.Value) {
                $rows.Add([pscustomobject]@{ hardware = $hardware.HardwareType.ToString(); device = [string]$hardware.Name; sensor = [string]$sensor.Name; celsius = [math]::Round([double]$sensor.Value, 1) })
            }
        }
        foreach ($sub in @($hardware.SubHardware)) { Walk $sub }
    }
    foreach ($hardware in @($computer.Hardware)) { Walk $hardware }
    $payload = [ordered]@{ capturedAt = (Get-Date).ToString('o'); sensors = @($rows.ToArray()) }
    $parent = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temporary = "$OutputPath.$PID.tmp"
    $payload | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
    $computer.Close()
} catch {
    $parent = Split-Path -Parent $OutputPath
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    [ordered]@{ capturedAt = (Get-Date).ToString('o'); error = $_.Exception.Message; detail = ($_ | Out-String); sensors = @() } | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    exit 1
}
