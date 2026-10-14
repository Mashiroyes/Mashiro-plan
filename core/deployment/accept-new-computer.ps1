[CmdletBinding()]
param([string]$RunId,[string]$ReportPath,[string]$DeploymentReportPath,[string]$RuntimeDescriptorPath=(Join-Path $env:LOCALAPPDATA 'MashiroBot\config\runtime.json'),[string[]]$ConfirmedCommands=@(),[string]$WeixinEvidencePath,[switch]$QqLifecycleConfirmed,[switch]$SkipQqLifecycle,[string]$FixtureJson)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$OutputEncoding
$planRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot);if(-not$RunId){$RunId=Get-Date -Format 'yyyyMMdd-HHmmss'};$runRoot=Join-Path $env:LOCALAPPDATA "MashiroBot\deployments\$RunId";if(-not$ReportPath){$ReportPath=Join-Path $runRoot 'acceptance.json'}
function Check([string]$name,[string]$level,[string]$status,$evidence,[string]$error=$null){[ordered]@{name=$name;level=$level;status=$status;ok=($status-eq'passed');evidence=$evidence;error=$error;checkedAt=[DateTimeOffset]::Now.ToString('o')}}
$checks=[Collections.Generic.List[object]]::new()
if($FixtureJson){
 $fixture=$FixtureJson|ConvertFrom-Json
 foreach($entry in $fixture.checks){$entryError=if($entry.PSObject.Properties['error']){[string]$entry.error}else{$null};$check=Check ([string]$entry.name) ([string]$entry.level) ([string]$entry.status) $entry.evidence $entryError;$checks.Add($check)}
}
else{
 if(-not(Test-Path -LiteralPath $RuntimeDescriptorPath -PathType Leaf)){throw "Runtime descriptor is missing: $RuntimeDescriptorPath"};$runtime=Get-Content -LiteralPath $RuntimeDescriptorPath -Raw -Encoding UTF8|ConvertFrom-Json
 $healthRaw=@(& ([string]$runtime.pwshPath) -NoProfile -NonInteractive -File (Join-Path $planRoot 'core\health\check-mashirobot.ps1') -Runtime 2>&1);$healthOk=$LASTEXITCODE-eq 0;$checks.Add((Check 'runtime-health' runtime $(if($healthOk){'passed'}else{'failed'}) @{output=($healthRaw-join[Environment]::NewLine)} $(if($healthOk){$null}else{'MashiroBot runtime health failed.'})))
 $websiteRaw=@(& ([string]$runtime.pwshPath) -NoProfile -NonInteractive -File (Join-Path $planRoot 'core\deployment\test-website-layers.ps1') -StatusOnly 2>&1);$website=try{($websiteRaw-join[Environment]::NewLine)|ConvertFrom-Json}catch{$null};$checks.Add((Check 'website-layers' runtime $(if($website-and$website.ok){'passed'}else{'failed'}) $website $(if($website-and$website.ok){$null}else{'Website layer status is incomplete or failed.'})))
 $weixinEvidence=if($WeixinEvidencePath-and(Test-Path -LiteralPath $WeixinEvidencePath -PathType Leaf)){@(Get-Content -LiteralPath $WeixinEvidencePath -Raw -Encoding UTF8|ConvertFrom-Json)}else{@()}
 foreach($command in @('帮助','状态','查询今日计划')){
  $humanConfirmed=@($ConfirmedCommands|Where-Object{$_-eq$command}).Count-gt 0
  $matched=@($weixinEvidence|Where-Object{$_.command -eq $command -and $_.routeId -and $_.replyClass -and $_.timestamp -and $_.gatewayLogMatched -eq $true})|Select-Object -First 1
  $passed=$humanConfirmed -and $null -ne $matched
  $checks.Add((Check "weixin-$command" human_confirmed $(if($passed){'passed'}else{'unverified'}) @{command=$command;humanConfirmed=$humanConfirmed;routeEvidence=$matched} $(if($passed){$null}else{"Send '$command', confirm it, and provide matching route/Gateway evidence."})))
 }
 if($QqLifecycleConfirmed){$checks.Add((Check 'qq-lifecycle' human_confirmed passed @{confirmed=$true}))}
 elseif($SkipQqLifecycle){$checks.Add((Check 'qq-lifecycle' human_confirmed unverified @{skipped=$true} 'QQ lifecycle was explicitly skipped.'))}
 else{$checks.Add((Check 'qq-lifecycle' human_confirmed unverified @{skipped=$false} 'Run the optional short QQ lifecycle and confirm protection restoration.'))}
}
$failed=@($checks|Where-Object status -eq 'failed');$unverified=@($checks|Where-Object status -eq 'unverified');$warnings=@($checks|Where-Object status -eq 'warning');$status=if($failed.Count){'failed'}elseif($unverified.Count){'unverified'}elseif($warnings.Count){'completed_with_warnings'}else{'passed'}
$result=[ordered]@{schemaVersion=1;runId=$RunId;status=$status;checks=@($checks);failed=@($failed|ForEach-Object{$_.name});unverified=@($unverified|ForEach-Object{$_.name});completedAt=[DateTimeOffset]::Now.ToString('o')}
New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force|Out-Null;$tmp="$ReportPath.tmp-$([guid]::NewGuid().ToString('N'))";$result|ConvertTo-Json -Depth 14|Set-Content -LiteralPath $tmp -Encoding UTF8;Move-Item -LiteralPath $tmp -Destination $ReportPath -Force
if(-not$DeploymentReportPath){$candidate=Join-Path $runRoot 'report.json';if(Test-Path -LiteralPath $candidate -PathType Leaf){$DeploymentReportPath=$candidate}}
if($DeploymentReportPath-and(Test-Path -LiteralPath $DeploymentReportPath -PathType Leaf)){
 $deployment=Get-Content -LiteralPath $DeploymentReportPath -Raw -Encoding UTF8|ConvertFrom-Json
 if($deployment.phases-and$deployment.phases.acceptance){
  $phase=$deployment.phases.acceptance;$phase.status=$status;$phase.finishedAt=[DateTimeOffset]::Now.ToString('o');$phase.exitCode=if($failed.Count){1}else{0};$phase.error=if($failed.Count){'Acceptance contains failed checks.'}else{$null};$phase.evidencePaths=@($ReportPath,$WeixinEvidencePath|Where-Object{$_})
  $deployment.status=if($failed.Count){'failed'}elseif($unverified.Count){'unverified'}else{'passed'};$deployment.finishedAt=[DateTimeOffset]::Now.ToString('o')
  $deploymentTmp="$DeploymentReportPath.tmp-$([guid]::NewGuid().ToString('N'))";$deployment|ConvertTo-Json -Depth 14|Set-Content -LiteralPath $deploymentTmp -Encoding UTF8;Move-Item -LiteralPath $deploymentTmp -Destination $DeploymentReportPath -Force
 }
}
$result|ConvertTo-Json -Depth 14;if($failed.Count){exit 1}
