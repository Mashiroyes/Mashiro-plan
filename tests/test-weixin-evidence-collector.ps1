$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$root=Join-Path ([IO.Path]::GetTempPath()) ('weixin-evidence-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $root|Out-Null
try {
 $m=Join-Path $root 'mashirobot.log';$g=Join-Path $root 'gateway';New-Item -ItemType Directory $g|Out-Null;$o=Join-Path $root 'evidence.json'
 @(
  '{"timestamp":"2026-10-01T00:10:01+08:00","pluginId":"mashirobot-core","event":"route_completed","message":"帮助菜单"}',
  '{"timestamp":"2026-10-01T00:10:02+08:00","pluginId":"mashirobot-plugin-status","event":"route_completed","message":"状态"}',
  '{"timestamp":"2026-10-01T00:10:03+08:00","pluginId":"mashirobot-plugin-plan","event":"route_completed","message":"查询计划"}'
 )|Set-Content -LiteralPath $m -Encoding UTF8
 @(
  '{"1":"[weixin] Fast routine command handled command=帮助菜单, skipping AI pipeline","time":"2026-10-01T00:10:04+08:00"}',
  '{"1":"[weixin] Fast routine command handled command=状态, skipping AI pipeline","time":"2026-10-01T00:10:05+08:00"}',
  '{"1":"[weixin] Fast routine command handled command=查询计划, skipping AI pipeline","time":"2026-10-01T00:10:06+08:00"}'
 )|Set-Content -LiteralPath (Join-Path $g 'openclaw-2026-10-01.log') -Encoding UTF8
 & (Join-Path (Split-Path -Parent $PSScriptRoot) 'core\deployment\collect-weixin-evidence.ps1') -Since '2026-10-01T00:10:00+08:00' -OutputPath $o -MashiroBotLogPath $m -GatewayLogDirectory $g|Out-Null
 $result=@(Get-Content -Raw $o|ConvertFrom-Json);if($result.Count-ne 3){throw "Expected 3 evidence rows, got $($result.Count)"};if(@($result|Where-Object{-not$_.gatewayLogMatched}).Count){throw 'Every row must match a Gateway event.'};if($result[2].routeId-ne'mashirobot-plugin-plan/query-plan'){throw 'Unexpected query-plan route id.'}
 Write-Output 'PASS: WeChat evidence collector correlates local and Gateway routes'
}finally{Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
