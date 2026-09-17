$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('mashirobot-status-render-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
try {
    $payload = [ordered]@{
        hostname='TEST-PC'; uptimeSeconds=93784
        cpu=[ordered]@{ usagePercent=10; cores=4; threads=8; model='Test CPU' }
        memory=[ordered]@{ usedBytes=600; totalBytes=1000; usagePercent=60 }
        temperatures=[ordered]@{ cpuCelsius=55; gpuCelsius=44; diskCelsius=50; motherboardCelsius=42 }
        disks=@([ordered]@{ name='C:'; totalBytes=1000; freeBytes=250 })
        networkProbes=@([ordered]@{ name='百度'; status=200; latencyMs=12 })
        processes=@([ordered]@{ name='large'; cpuPercent=1; memoryBytes=500 })
        hardware=[ordered]@{ processor='Test CPU'; motherboard='Test Board'; memory='16GB'; graphics=@('Test GPU'); monitors=@('Test Monitor'); physicalDisks=@('Test Disk'); audio=@('Test Audio'); networkAdapters=@('Test Adapter') }
    }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 8 -Compress)))
    $renderer = Join-Path (Split-Path -Parent $PSScriptRoot) 'render\status-card.py'
    $statusPath = Join-Path $root 'status.png'; $hardwarePath = Join-Path $root 'hardware.png'; $temperaturePath = Join-Path $root 'temperature.png'
    & python $renderer --payload-base64 $encoded --output $statusPath --kind status
    & python $renderer --payload-base64 $encoded --output $hardwarePath --kind hardware
    & python $renderer --payload-base64 $encoded --output $temperaturePath --kind temperature
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $statusPath) -or -not (Test-Path -LiteralPath $hardwarePath) -or -not (Test-Path -LiteralPath $temperaturePath)) { throw 'Renderer did not create all images.' }
    $inspect = "import sys; from PIL import Image; a=Image.open(sys.argv[1]); b=Image.open(sys.argv[2]); status_text=a.info.get('mashirobot-text',''); hardware_text=b.info.get('mashirobot-text',''); avatar=a.getpixel((114,90)); background=a.getpixel((45,90)); assert a.width==1200 and b.width==1200; assert sum(abs(x-y) for x,y in zip(avatar,background)) > 40; assert 'SWAP' not in status_text and '网卡' not in status_text; assert '显卡' not in hardware_text and '网卡' not in hardware_text; print(a.size,b.size)"
    & python -c $inspect $statusPath $hardwarePath
    if ($LASTEXITCODE -ne 0) { throw 'Renderer metadata assertion failed.' }
    [pscustomobject]@{ ok=$true; status=$statusPath; hardware=$hardwarePath; temperature=$temperaturePath } | ConvertTo-Json -Compress
} finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
