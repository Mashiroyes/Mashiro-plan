[CmdletBinding()]
param([switch]$StaticOnly)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$windowsDir = Join-Path $pluginRoot 'windows'
$playbackPath = Join-Path $windowsDir 'cloudmusic-playback.ps1'
$workerPath = Join-Path $windowsDir 'routine-reminder.ps1'

. $playbackPath

foreach ($functionName in @(
    'Send-SystemMediaPlayPause',
    'Test-CloudMusicPlaybackActive',
    'Start-CloudMusicPlayback'
)) {
    if (-not (Get-Command $functionName -CommandType Function -ErrorAction SilentlyContinue)) {
        throw "缺少播放函数：$functionName"
    }
}

$playbackSource = [IO.File]::ReadAllText($playbackPath, [Text.Encoding]::UTF8)
foreach ($marker in @(
    'VK_MEDIA_PLAY_PAUSE',
    'Send-SystemMediaPlayPause',
    'foreground-space-skipped',
    'targeted-media-command-fallback'
)) {
    if (-not $playbackSource.Contains($marker)) {
        throw "播放脚本缺少标记：$marker"
    }
}

$workerSource = [IO.File]::ReadAllText($workerPath, [Text.Encoding]::UTF8)
foreach ($marker in @(
    'Checking CloudMusic playback on this wakeup run.',
    'CloudMusic is already producing audio; playback action skipped.',
    'CloudMusic is silent; retrying playback.'
)) {
    if (-not $workerSource.Contains($marker)) {
        throw "起床执行器缺少重试标记：$marker"
    }
}

if ($StaticOnly) {
    'PASS: 网易云后台播放静态检查通过。'
    exit 0
}

$cloudMusicPath = 'D:\Program\CloudMusic\cloudmusic.exe'
$result = Start-CloudMusicPlayback -ExecutablePath $cloudMusicPath
if (-not (Test-CloudMusicPlaybackActive -DurationMilliseconds 1800)) {
    throw '播放函数返回后仍未检测到音频。'
}

$result | ConvertTo-Json -Depth 5

