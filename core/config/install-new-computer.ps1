[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateSet('Preflight','Configure','Install','Verify','Inspect','Report','All')][string]$Action,
 [ValidateSet('Core','Standard','Full')][string]$Profile='Standard',[string]$RunId=(Get-Date -Format 'yyyyMMdd-HHmmss'),[switch]$Resume,
 [string]$SqlitePath,[string]$OpenClawCommand,[string]$OpenClawPackageRoot,[string]$WeixinAccount,[string]$WeixinTarget,[string]$CloudMusicPath,
 [string]$PwshPath,[string]$NodePath,[string]$PythonPath,[switch]$ProvisionPythonRuntime,[switch]$SkipIdentityProbes
)
$ErrorActionPreference='Stop';$PSNativeCommandUseErrorActionPreference=$false;Set-StrictMode -Version Latest
$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$OutputEncoding
$planRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot);if(-not$SqlitePath){$SqlitePath=Join-Path $planRoot 'sqlite\openclaw-planner.sqlite'};$SqlitePath=[IO.Path]::GetFullPath($SqlitePath)
$configPath=Join-Path $env:LOCALAPPDATA 'MashiroBot\config\machine.json';$runtimePath=Join-Path $env:LOCALAPPDATA 'MashiroBot\config\runtime.json';$runRoot=Join-Path $env:LOCALAPPDATA "MashiroBot\deployments\$RunId";$reportPath=Join-Path $runRoot 'report.json'
$phaseNames=@('preflight','configure','backup','adapter','gateway-watchdog','core-features','optional-features','gateway-start','static-verify','acceptance','report')
function New-Phase {[ordered]@{status='pending';startedAt=$null;finishedAt=$null;exitCode=$null;evidencePaths=@();warnings=@();error=$null}}
function New-State {$p=[ordered]@{};foreach($n in $phaseNames){$p[$n]=New-Phase};[ordered]@{schemaVersion=1;runId=$RunId;profile=$Profile;startedAt=[DateTimeOffset]::Now.ToString('o');finishedAt=$null;status='running';planRoot=$planRoot;sqlitePath=$SqlitePath;runtimeDescriptorPath=$runtimePath;phases=$p}}
function Load-State {if($Resume-and(Test-Path -LiteralPath $reportPath)){Get-Content -LiteralPath $reportPath -Raw|ConvertFrom-Json}else{New-State}}
function Save-State($s){New-Item -ItemType Directory -Path $runRoot -Force|Out-Null;$tmp="$reportPath.tmp-$([guid]::NewGuid().ToString('N'))";$s|ConvertTo-Json -Depth 14|Set-Content -LiteralPath $tmp -Encoding UTF8;Move-Item -LiteralPath $tmp -Destination $reportPath -Force}
function Set-Phase($s,[string]$n,[string]$status,[int]$code=0,[string]$error=$null,[string[]]$evidence=@()){$p=$s.phases.$n;if($status-eq'running'){$p.startedAt=[DateTimeOffset]::Now.ToString('o')};if($status-in@('passed','failed','skipped','unverified')){$p.finishedAt=[DateTimeOffset]::Now.ToString('o')};$p.status=$status;$p.exitCode=$code;$p.error=$error;$p.evidencePaths=@($evidence);Save-State $s}
function Invoke-Checked([string]$label,[string]$script,[string[]]$arguments=@()){$exe=if(Test-Path $runtimePath){[string](Get-Content $runtimePath -Raw|ConvertFrom-Json).pwshPath}elseif($PwshPath){$PwshPath}else{(Get-Command pwsh.exe -ErrorAction Stop).Source};$out=@(& $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script @arguments 2>&1);if($LASTEXITCODE-ne 0){throw "$label failed (exit $LASTEXITCODE): $($out-join[Environment]::NewLine)"};$out}
function Invoke-Phase($s,[string]$n,[scriptblock]$body){if($Resume-and$s.phases.$n.status-eq'passed'){return};Set-Phase $s $n running;try{$ev=@(&$body);Set-Phase $s $n passed 0 $null @($ev|ForEach-Object{[string]$_})}catch{Set-Phase $s $n failed 1 $_.Exception.Message;throw}}
function Require-Admin {$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($id);if(-not$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Install must run from an elevated PowerShell 7 window.'}}
function Install-Or-ReapplyFocusLock {
 $focusLockScript=Join-Path $planRoot 'focus-lock\FocusLock.ps1'
 $focusLockState=Join-Path $env:ProgramData 'CodexFocusLock\state.json'
 $mode=if(Test-Path -LiteralPath $focusLockState -PathType Leaf){'Reapply'}else{'Install'}
 Invoke-Checked "FocusLock $mode" $focusLockScript @('-Mode',$mode)|Out-Null
 "focus-lock-$($mode.ToLowerInvariant())"
}
function Wait-GatewayReady {
 param([Parameter(Mandatory)][string]$OpenClaw,[int]$TimeoutSeconds=60)
 $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
 do {
  $output=@(& $OpenClaw gateway health --timeout 8000 2>&1)
  if($LASTEXITCODE-eq 0-and($output-join"`n")-match'(?m)^OK\s*\('){return 'gateway-health-passed'}
  if((Get-Date)-lt$deadline){Start-Sleep -Seconds 3}
 }while((Get-Date)-lt$deadline)
 throw "Gateway did not become healthy within $TimeoutSeconds seconds: $($output-join[Environment]::NewLine)"
}
function Test-OptionalFeaturesCurrent {
 $source=Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\qq\powershell\qq-session-worker-v1.ps1'
 $installed=Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq\workers\qq-session-worker-v1.ps1'
 if(-not(Test-Path -LiteralPath $source -PathType Leaf)-or-not(Test-Path -LiteralPath $installed -PathType Leaf)){return $false}
 return (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash-eq(Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
}
function Test-RuntimeDescriptorReady {
 if(-not(Test-Path -LiteralPath $runtimePath -PathType Leaf)){return $false}
 try {
  $r=Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8|ConvertFrom-Json
  if([int]$r.schemaVersion -ne 1 -or @($r.identityProbes).Count -ne 3){return $false}
  foreach($p in @($r.planRoot,$r.sqlitePath,$r.pwshPath,$r.nodePath,$r.pythonPath,$r.openClawCommand,$r.openClawPackageRoot)){if(-not(Test-Path -LiteralPath ([string]$p))){return $false}}
  return @($r.identityProbes|Where-Object{-not$_.ok}).Count -eq 0
 } catch {return $false}
}
$state=Load-State;Save-State $state
try{
 if($Action-in@('Preflight','Install','All')){if($Resume-and(Test-RuntimeDescriptorReady)){Set-Phase $state preflight passed 0 $null @($runtimePath,'reused-verified-runtime-descriptor')}else{Invoke-Phase $state preflight {$selectedPython=$PythonPath;if($ProvisionPythonRuntime){$pythonResult=(Invoke-Checked 'Python runtime provisioning' (Join-Path $planRoot 'core\deployment\ensure-python-runtime.ps1')|Select-Object -Last 1)|ConvertFrom-Json;$selectedPython=[string]$pythonResult.pythonPath};$a=@('-PlanRoot',$planRoot,'-SqlitePath',$SqlitePath,'-OutputPath',$runtimePath);if($PwshPath){$a+=@('-PwshPath',$PwshPath)};if($NodePath){$a+=@('-NodePath',$NodePath)};if($selectedPython){$a+=@('-PythonPath',$selectedPython)};if($OpenClawCommand){$a+=@('-OpenClawCommand',$OpenClawCommand)};if($OpenClawPackageRoot){$a+=@('-OpenClawPackageRoot',$OpenClawPackageRoot)};if($SkipIdentityProbes){$a+='-SkipIdentityProbes'};Invoke-Checked 'Runtime preflight' (Join-Path $planRoot 'core\deployment\resolve-runtime.ps1') $a|Out-Null;$runtimePath}}}
 if($Action-eq'Preflight'){$state.status='passed';$state.finishedAt=[DateTimeOffset]::Now.ToString('o');Save-State $state;$state|ConvertTo-Json -Depth 14;exit 0}
 if($Action-in@('Configure','Install','All')){
  if($WeixinTarget){Invoke-Phase $state configure {$a=@('-WeixinTarget',$WeixinTarget);if($OpenClawCommand){$a+=@('-OpenClawCommand',$OpenClawCommand)};if($WeixinAccount){$a+=@('-WeixinAccount',$WeixinAccount)};if($CloudMusicPath){$a+=@('-CloudMusicPath',$CloudMusicPath)};Invoke-Checked 'Machine configuration' (Join-Path $PSScriptRoot 'initialize-machine-config.ps1') $a|Out-Null;$configPath}}
  elseif($Action-eq'Configure'){throw 'Configure requires -WeixinTarget.'}
  elseif(Test-Path -LiteralPath $configPath -PathType Leaf){$existing=Get-Content -LiteralPath $configPath -Raw -Encoding UTF8|ConvertFrom-Json;if([int]$existing.schemaVersion-ne 1-or-not[string]$existing.weixinTarget){throw 'Existing machine.json is invalid or has no WeChat target.'};Set-Phase $state configure passed 0 $null @($configPath,'reused-existing-machine-config')}
  else{throw 'Install requires either an existing valid machine.json or -WeixinTarget.'}
 }
 if($Action-eq'Configure'){$state.status='passed';$state.finishedAt=[DateTimeOffset]::Now.ToString('o');Save-State $state;$state|ConvertTo-Json -Depth 14;exit 0}
 if($Action-in@('Install','All')){
  Require-Admin;if(-not(Test-Path $runtimePath)){throw "Runtime descriptor is missing: $runtimePath"};$rt=Get-Content $runtimePath -Raw|ConvertFrom-Json
  Invoke-Phase $state backup {$b=Join-Path $runRoot backups;New-Item -ItemType Directory -Path $b -Force|Out-Null;if(Test-Path $configPath){Copy-Item $configPath (Join-Path $b machine.json)-Force};Copy-Item $SqlitePath (Join-Path $b openclaw-planner.sqlite)-Force;$b}
  Invoke-Phase $state adapter {Invoke-Checked 'Adapter' (Join-Path $planRoot 'core\adapter\repair-openclaw-adapter.ps1') @('-PackageRoot',[string]$rt.openClawPackageRoot,'-NodePath',[string]$rt.nodePath)|Out-Null;'adapter-repaired'}
  Invoke-Phase $state 'gateway-watchdog' {Invoke-Checked 'Gateway watchdog' (Join-Path $planRoot 'core\health\install-openclaw-gateway-watchdog.ps1')|Out-Null;'watchdog-installed'}
  Invoke-Phase $state 'core-features' {Invoke-Checked 'Loot' (Join-Path $planRoot 'plugin\mashirobot-plugin-loot\windows\install.ps1') @('-Action','Install','-SqlitePath',$SqlitePath,'-RuntimeDescriptorPath',$runtimePath)|Out-Null;Invoke-Checked 'English skills' (Join-Path $planRoot 'plugin\mashirobot-plugin-plan\windows\install-english-skills.ps1') @('-Action','Install','-SqlitePath',$SqlitePath,'-RuntimeDescriptorPath',$runtimePath)|Out-Null;'core-features-installed'}
  if($Profile-eq'Core'){Set-Phase $state 'optional-features' skipped 0 $null @('Profile Core')}else{if($Resume-and$state.phases.'optional-features'.status-eq'passed'-and-not(Test-OptionalFeaturesCurrent)){Set-Phase $state 'optional-features' pending 0 $null @('installed-worker-drift-detected')};Invoke-Phase $state 'optional-features' {$focusLockEvidence=Install-Or-ReapplyFocusLock;Invoke-Checked 'Block' (Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\block\powershell\install-block.ps1') @('-Mode','Install','-SqlitePath',$SqlitePath,'-RuntimeDescriptorPath',$runtimePath)|Out-Null;Invoke-Checked 'Game locker' (Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\game-locker\powershell\install-game-locker.ps1') @('-Mode','Install','-SqlitePath',$SqlitePath,'-RuntimeDescriptorPath',$runtimePath)|Out-Null;Invoke-Checked 'QQ' (Join-Path $planRoot 'plugin\mashirobot-plugin-game-timer\qq\powershell\install-qq-session.ps1') @('-Mode','Install','-SqlitePath',$SqlitePath,'-RuntimeDescriptorPath',$runtimePath)|Out-Null;$focusLockEvidence;'optional-features-installed'}}
  Invoke-Phase $state 'gateway-start' {Invoke-Checked 'Gateway start' (Join-Path $planRoot 'core\adapter\start-openclaw-gateway.ps1')|Out-Null;$gatewayEvidence=Wait-GatewayReady -OpenClaw ([string]$rt.openClawCommand);'gateway-started';$gatewayEvidence}
 }
 if($Action-in@('Verify','Inspect','Install','All')){Invoke-Phase $state 'static-verify' {Invoke-Checked 'Static health' (Join-Path $planRoot 'core\health\check-mashirobot.ps1') @('-Static')|Out-Null;Invoke-Checked 'Runtime health' (Join-Path $planRoot 'core\health\check-mashirobot.ps1') @('-Runtime')|Out-Null;'static-and-runtime-health-passed'};Set-Phase $state acceptance unverified 0 $null @((Join-Path $planRoot 'core\deployment\accept-new-computer.ps1'))}
 $failed=@($phaseNames|Where-Object{$state.phases.$_.status-eq'failed'});$unverified=@($phaseNames|Where-Object{$state.phases.$_.status-eq'unverified'});$state.status=if($failed.Count){'failed'}elseif($unverified.Count){'unverified'}else{'passed'};$state.finishedAt=[DateTimeOffset]::Now.ToString('o');Set-Phase $state report passed 0 $null @($reportPath);Save-State $state;$state|ConvertTo-Json -Depth 14
}catch{$state.status='failed';$state.finishedAt=[DateTimeOffset]::Now.ToString('o');Save-State $state;[Console]::Error.WriteLine($_.Exception.Message);exit 1}
