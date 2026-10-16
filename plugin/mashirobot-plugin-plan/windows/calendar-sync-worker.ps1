[CmdletBinding()]
param(
    [ValidateSet('Inspect','DryRunBackfill','Backfill','Reconcile')][string]$Action='Reconcile',
    [ValidateRange(1,1000)][int]$Limit=100,
    [string]$SqlitePath
)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$OutputEncoding
. (Join-Path $PSScriptRoot 'calendar-credential.ps1')
$pluginRoot = Split-Path -Parent $PSScriptRoot
$planner = Join-Path $pluginRoot 'planner\planner.py'
$caldav = Join-Path $pluginRoot 'planner\caldav_sync.py'
$runtimeDescriptor = Join-Path $env:LOCALAPPDATA 'MashiroBot\config\runtime.json'
$configuredPython = if(Test-Path -LiteralPath $runtimeDescriptor){
    try { [string](Get-Content -LiteralPath $runtimeDescriptor -Raw -Encoding UTF8 | ConvertFrom-Json).pythonPath } catch { $null }
} else { $null }
$python = if($env:MASHIROBOT_PYTHON){
    $env:MASHIROBOT_PYTHON
} elseif($configuredPython -and (Test-Path -LiteralPath $configuredPython -PathType Leaf)) {
    $configuredPython
} else {
    (Get-Command python.exe -ErrorAction Stop).Source
}
if(-not $SqlitePath){$SqlitePath=$env:OPENCLAW_PLANNER_DB_PATH}
if(-not $SqlitePath){$SqlitePath=Join-Path (Split-Path -Parent (Split-Path -Parent $pluginRoot)) 'sqlite\openclaw-planner.sqlite'}
$env:OPENCLAW_PLANNER_DB_PATH=[IO.Path]::GetFullPath($SqlitePath)

function Invoke-Planner([string[]]$Arguments){
    $raw=& $python $planner @Arguments 2>&1
    if($LASTEXITCODE-ne 0){throw($raw-join[Environment]::NewLine)}
    return(($raw-join'')|ConvertFrom-Json -AsHashtable)
}
function Encode-Json([hashtable]$Value){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Compress -Depth 12)))}

if($Action-eq'Inspect'){
    $status=Invoke-Planner @('calendar-status')
    [pscustomobject]@{ok=$true;credentialPresent=($null-ne(Get-PlanCalendarCredential));database=$env:OPENCLAW_PLANNER_DB_PATH;status=$status} | ConvertTo-Json -Compress -Depth 12
    exit 0
}
if($Action-eq'DryRunBackfill'){
    $pending=Invoke-Planner @('calendar-pending','--limit',$Limit)
    [pscustomobject]@{ok=$true;dryRun=$true;existingPending=@($pending.items).Count;settings=$pending.settings} | ConvertTo-Json -Compress -Depth 8
    exit 0
}
if($Action-eq'Backfill'){[void](Invoke-Planner @('calendar-backfill'))}
$pending=Invoke-Planner @('calendar-pending','--limit',$Limit)
$credential=Get-PlanCalendarCredential
if($null-eq$credential){
    [pscustomobject]@{ok=$false;paused=$true;reason='credential-missing';pending=@($pending.items).Count} | ConvertTo-Json -Compress
    exit 2
}
$results=@()
try{
    foreach($item in @($pending.items)){
        $request=@{action='reconcile';account=[string]$pending.settings.account;endpoint=[string]$pending.settings.endpoint;calendarName=[string]$pending.settings.calendar_name;calendarUrl=$pending.settings.calendar_url;intent=$item}
        $env:MASHIROBOT_QQ_CALDAV_PASSWORD=$credential
        $json=$request|ConvertTo-Json -Compress -Depth 12
        $raw=$json|& $python $caldav 2>&1
        $exit=$LASTEXITCODE
        Remove-Item Env:MASHIROBOT_QQ_CALDAV_PASSWORD -ErrorAction SilentlyContinue
        try {$receipt=(($raw-join'')|ConvertFrom-Json -AsHashtable)}
        catch {throw "CalDAV helper returned invalid output (exit $exit): $($raw-join[Environment]::NewLine)"}
        $finish=@{planItemId=[string]$item.plan_item_id;status=[string]$receipt.status;error=$receipt.error;remoteUrl=$receipt.remoteUrl;etag=$receipt.etag;calendarUrl=$receipt.calendarUrl}
        if($receipt.retryable){$finish.nextAttemptAt=[DateTimeOffset]::Now.AddMinutes([Math]::Min(60,[Math]::Pow(2,[Math]::Min(6,[int]$item.attempt_count)))).ToString('o')}
        [void](Invoke-Planner @('calendar-finish','--payload-base64',(Encode-Json $finish)))
        $results+=[pscustomobject]@{planItemId=$item.plan_item_id;status=$receipt.status;exitCode=$exit}
        if($receipt.status-eq'paused'){break}
    }
}finally{
    Remove-Item Env:MASHIROBOT_QQ_CALDAV_PASSWORD -ErrorAction SilentlyContinue
    $credential=$null
}
[pscustomobject]@{ok=(@($results|Where-Object status -ne 'synced').Count-eq 0);processed=$results.Count;results=$results} | ConvertTo-Json -Compress -Depth 8
