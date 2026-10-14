$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$Root=Join-Path $env:TEMP ('MashiroWebsite-'+[guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $Root|Out-Null
try{
 $state=Join-Path $Root 'state.json';@{LastSync=@{layers=@{hosts=@{ok=$true;required=$true};browserPolicy=@{ok=$true;required=$true};clashPersistent=@{ok=$true;required=$false};clashReload=@{ok=$true;required=$false}}}}|ConvertTo-Json -Depth 8|Set-Content $state -Encoding UTF8
 $script=Join-Path (Split-Path -Parent $PSScriptRoot) 'core\deployment\test-website-layers.ps1';$raw=& $script -BlockStatePath $state -StatusOnly;$r=$raw|ConvertFrom-Json;if(-not$r.ok){throw 'Status-only layer report must pass when installed layers pass.'}
 foreach($name in @('hosts','browserPolicy','clashPersistent','clashReload','directProbe','proxyProbe','controlProbe')){if(-not$r.layers.PSObject.Properties[$name]){throw "Missing website layer: $name"}}
 if($r.layers.directProbe.status-ne'unverified'){throw 'Status-only direct probe must remain unverified.'};if($r.layers.proxyProbe.status-ne'unverified'){throw 'Status-only proxy probe must remain unverified.'}
 Write-Output 'PASS: website layer report keeps static and access evidence separate'
}finally{Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue}
