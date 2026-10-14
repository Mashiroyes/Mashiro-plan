param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'FocusLock.ps1'
$runtimeRoot = Join-Path $env:ProgramData 'CodexFocusLock'
$runtime = Join-Path $runtimeRoot 'FocusLock.ps1'
$resultPath = Join-Path $PSScriptRoot 'adult-content-block-verification.json'

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'),'-Elevated')
    $process = Start-Process -FilePath 'pwsh.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    exit $process.ExitCode
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
try {
    Copy-Item -LiteralPath $source -Destination $runtime -Force
    $reapplyOutput = @(& pwsh -NoProfile -ExecutionPolicy Bypass -File $runtime -Mode Reapply 2>&1 | ForEach-Object { $_.ToString() })
    if ($LASTEXITCODE -ne 0) { throw "FocusLock Reapply exited $LASTEXITCODE`: $($reapplyOutput -join ' | ')" }
    $status = & pwsh -NoProfile -ExecutionPolicy Bypass -File $runtime -Mode Status | ConvertFrom-Json
    Start-ScheduledTask -TaskName 'CodexFocusLock-Repair' -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $repairTask = Get-ScheduledTask -TaskName 'CodexFocusLock-Repair'
    } while ($repairTask.State -eq 'Running' -and (Get-Date) -lt $deadline)
    $taskEvidence = @('CodexFocusLock-Repair','CodexFocusLock-QQScan') | ForEach-Object {
        $task = Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue
        $info = Get-ScheduledTaskInfo -TaskName $_ -ErrorAction SilentlyContinue
        [pscustomobject]@{ TaskName=$_; Exists=($null -ne $task); State=if($task){[string]$task.State}else{$null}; LastTaskResult=if($info){$info.LastTaskResult}else{$null}; NextRunTime=if($info){$info.NextRunTime}else{$null} }
    }
    $browserEvidence = @(@('HKLM:\SOFTWARE\Policies\Google\Chrome','HKLM:\SOFTWARE\Policies\Microsoft\Edge') | ForEach-Object {
        $policy = Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue
        [pscustomobject]@{ Root=$_; DnsOverHttpsMode=$policy.DnsOverHttpsMode }
    })
    $report = [pscustomobject]@{
        Timestamp = [datetimeoffset]::Now.ToString('o')
        SourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        RuntimeSha256 = (Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash
        Status = $status
        TaskEvidence = $taskEvidence
        BrowserEvidence = $browserEvidence
        Error = $null
    }
} catch {
    $report = [pscustomobject]@{ Timestamp=[datetimeoffset]::Now.ToString('o'); Error=$_.Exception.Message; ScriptStackTrace=$_.ScriptStackTrace }
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath -Encoding UTF8
if ($report.Error) { exit 1 }
