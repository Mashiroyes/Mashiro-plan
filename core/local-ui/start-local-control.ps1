[CmdletBinding()]
param([switch]$Foreground)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'start.mjs'
$args = @($script)
if ($Foreground) { & $node @args; exit $LASTEXITCODE }
Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $root -WindowStyle Hidden
Write-Output 'Plan 本地控制台启动请求已发送。地址见 %TEMP%\MashiroBot\local-control-url.txt。'
