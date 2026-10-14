[CmdletBinding()]
param(
 [string]$BlockStatePath=(Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-block\state.json'),
 [string[]]$BlockedUrls=@('https://www.bilibili.com'),[string]$ControlUrl='https://www.example.com',[string]$ProxyUrl,
 [switch]$StatusOnly,[string]$ProbeFixtureJson
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
function New-Result([bool]$ok,[bool]$required,$evidence,[string]$error=$null,[string]$status='checked'){[ordered]@{ok=$ok;required=$required;status=$status;evidence=$evidence;error=$error;checkedAt=[DateTimeOffset]::Now.ToString('o')}}
function Invoke-Probe([string]$url,[string]$kind,[string]$proxy=$null){
 if($ProbeFixtureJson){$f=$ProbeFixtureJson|ConvertFrom-Json;$v=$f.$kind;return New-Result ([bool]$v.ok) $true $v.evidence ([string]$v.error)}
 try{$p=@{Uri=$url;Method='Head';TimeoutSec=5;MaximumRedirection=0;ErrorAction='Stop'};if($proxy){$p.Proxy=$proxy};$r=Invoke-WebRequest @p;if($kind-eq'controlProbe'){New-Result $true $true @{url=$url;statusCode=[int]$r.StatusCode} $null}else{New-Result $false $true @{url=$url;statusCode=[int]$r.StatusCode} 'Blocked URL remained reachable.'}}
 catch{if($kind-eq'controlProbe'){New-Result $false $true @{url=$url} $_.Exception.Message}else{New-Result $true $true @{url=$url;blockedBy=$_.Exception.Message} $null}}
}
$last=$null;if(Test-Path -LiteralPath $BlockStatePath){try{$last=(Get-Content -LiteralPath $BlockStatePath -Raw -Encoding UTF8|ConvertFrom-Json).LastSync}catch{}}
$savedLayers=if($last-and$last.PSObject.Properties['layers']){$last.layers}else{[pscustomobject]@{hosts=$null;browserPolicy=$null;clashPersistent=$null;clashReload=$null}}
$layers=[ordered]@{hosts=$savedLayers.hosts;browserPolicy=$savedLayers.browserPolicy;clashPersistent=$savedLayers.clashPersistent;clashReload=$savedLayers.clashReload}
if($StatusOnly){$layers.directProbe=New-Result $false $false @{} $null 'unverified';$layers.proxyProbe=New-Result $false $false @{} $null 'unverified';$layers.controlProbe=New-Result $false $false @{} $null 'unverified'}
else{$layers.directProbe=Invoke-Probe $BlockedUrls[0] directProbe;$layers.controlProbe=Invoke-Probe $ControlUrl controlProbe;if($ProxyUrl){$layers.proxyProbe=Invoke-Probe $BlockedUrls[0] proxyProbe $ProxyUrl}else{$layers.proxyProbe=New-Result $false $false @{} $null 'skipped'}}
$requiredFailures=@($layers.GetEnumerator()|Where-Object{$_.Value -and $_.Value.required-and-not$_.Value.ok}|ForEach-Object{$_.Key})
[ordered]@{ok=($requiredFailures.Count-eq 0);layers=$layers;requiredFailures=$requiredFailures;checkedAt=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json -Depth 12
if($requiredFailures.Count){exit 1}
