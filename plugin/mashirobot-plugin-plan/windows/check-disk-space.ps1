$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$thresholdBytes = 20GB
$today = (Get-Date).ToString("yyyy-MM-dd")
. (Join-Path $PSScriptRoot 'reminder-common.ps1')

try {
    $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
        Where-Object { $null -ne $_.FreeSpace -and $null -ne $_.Size } |
        Sort-Object DeviceID

    $lowDisks = @($disks | Where-Object { [int64]$_.FreeSpace -lt $thresholdBytes })

    if ($lowDisks.Count -eq 0) {
        $state = [ordered]@{
            signature = ""
            lastAlertDate = ""
        }
        Set-PlanPluginState -StateKey 'disk-space:20gb' -State $state
        Write-Output "NO_REPLY"
        exit 0
    }

    $signature = ($lowDisks.DeviceID -join ",")
    $previousSignature = ""
    $previousAlertDate = ""

    $previous = Get-PlanPluginState -StateKey 'disk-space:20gb'
    if ($previous) {
        $previousSignature = [string]$previous.signature
        $previousAlertDate = [string]$previous.lastAlertDate
    }

    if ($signature -eq $previousSignature -and $today -eq $previousAlertDate) {
        Write-Output "NO_REPLY"
        exit 0
    }

    $details = $lowDisks | ForEach-Object {
        $freeGB = [math]::Round([double]$_.FreeSpace / 1GB, 1)
        $sizeGB = [math]::Round([double]$_.Size / 1GB, 1)
        "- $($_.DeviceID) 剩余 $freeGB GB（总容量 $sizeGB GB）"
    }

    $state = [ordered]@{
        signature = $signature
        lastAlertDate = $today
    }
    Set-PlanPluginState -StateKey 'disk-space:20gb' -State $state

    Write-Output "⚠️ 本地磁盘空间不足"
    $details | ForEach-Object { Write-Output $_ }
    Write-Output "剩余空间已低于 20 GB，请及时清理或迁移文件。"
    exit 0
}
catch {
    [Console]::Error.WriteLine("磁盘空间检查失败：$($_.Exception.Message)")
    exit 1
}
