$ErrorActionPreference = 'Stop'
$PluginRoot = Split-Path -Parent $PSScriptRoot
$Worker = Join-Path $PluginRoot 'powershell\game-timer-worker-v1.ps1'
$Fixture = Join-Path $PSScriptRoot 'worker-fixture.mjs'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('game-timer-worker-' + [guid]::NewGuid().ToString('N'))
$PathA = Join-Path $Root 'a\game-timer-fixture.exe'
$PathB = Join-Path $Root 'b\game-timer-fixture.exe'
$GracefulPath = Join-Path $Root 'graceful\game-timer-graceful-fixture.exe'
$GracefulMarker = Join-Path $Root 'graceful-close.txt'
$MismatchDatabase = Join-Path $Root 'mismatch.sqlite'
$ExactDatabase = Join-Path $Root 'exact.sqlite'
$GracefulDatabase = Join-Path $Root 'graceful.sqlite'

function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}

function Start-Fixture([string]$Path) {
    return Start-Process -FilePath $Path -ArgumentList '/d', '/c', 'ping -t 127.0.0.1' -PassThru -WindowStyle Hidden
}

try {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $PathA)) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $PathB)) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $GracefulPath)) | Out-Null
    Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination $PathA
    Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination $PathB

    $gracefulSource = Join-Path $Root 'graceful\GracefulFixture.cs'
    [IO.File]::WriteAllText($gracefulSource, @'
using System;
using System.IO;
using System.Windows.Forms;

public static class GracefulFixture {
    [STAThread]
    public static void Main(string[] args) {
        var form = new Form { Text = "Game Timer Graceful Fixture", Width = 320, Height = 160 };
        form.FormClosing += delegate { File.WriteAllText(args[0], "closed"); };
        Application.Run(form);
    }
}
'@, [Text.UTF8Encoding]::new($false))
    $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $csc /nologo /target:winexe /reference:System.Windows.Forms.dll /out:$GracefulPath $gracefulSource
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile graceful-close fixture.' }

    $mismatch = Start-Fixture $PathB
    Start-Sleep -Milliseconds 500
    & node $Fixture create $MismatchDatabase mismatch $PathA | Out-Null
    & pwsh -NoProfile -File $Worker -Mode Force -TaskId mismatch -SqlitePath $MismatchDatabase -ScheduledTaskName test-mismatch -DryRun
    $mismatch.Refresh()
    Assert-True (-not $mismatch.HasExited) 'Path-mismatched process was closed.'
    $state = (& node $Fixture get $MismatchDatabase mismatch | ConvertFrom-Json)
    Assert-True ($state.status -eq 'path_mismatch') 'Path mismatch was not recorded.'
    Stop-Process -Id $mismatch.Id -Force -ErrorAction SilentlyContinue

    $exact = Start-Fixture $PathA
    Start-Sleep -Milliseconds 500
    $reportedExactPath = [string](Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $exact.Id)).ExecutablePath
    & node $Fixture create $ExactDatabase exact $reportedExactPath | Out-Null
    $forceStarted = [DateTimeOffset]::UtcNow
    & pwsh -NoProfile -File $Worker -Mode Force -TaskId exact -SqlitePath $ExactDatabase -ScheduledTaskName test-exact -DryRun -FixtureQueueVault
    $forceElapsed = ([DateTimeOffset]::UtcNow - $forceStarted).TotalSeconds
    $exact.WaitForExit(5000) | Out-Null
    $exact.Refresh()
    $state = (& node $Fixture get $ExactDatabase exact | ConvertFrom-Json)
    if (-not $exact.HasExited) {
        $actual = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $exact.Id) | Select-Object Name, ExecutablePath, ProcessId
        throw ('Exact-path process was not closed. expected={0}; actual={1}; state={2}' -f $reportedExactPath, ($actual | ConvertTo-Json -Compress), ($state | ConvertTo-Json -Compress))
    }
    Assert-True ($state.status -eq 'closed') 'Closed process was not recorded.'
    Assert-True (@($state.closedPids) -contains $exact.Id) 'Closed PID was not recorded.'
    Assert-True ($forceElapsed -ge 2.5) 'Force fallback did not wait for the graceful-close window.'

    $vaultRows = & node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(d.prepare('select * from game_executable_vault').all()));d.close()" $ExactDatabase | ConvertFrom-Json
    Assert-True (@($vaultRows).Count -eq 1) 'Forced game did not queue exactly one vault record.'
    Assert-True ($vaultRows[0].state -eq 'pending') 'Forced game vault record was not queued as pending.'

    $graceful = Start-Process -FilePath $GracefulPath -ArgumentList $GracefulMarker -PassThru
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 100
        $graceful.Refresh()
        if ($graceful.MainWindowHandle -ne 0) { break }
    }
    $reportedGracefulPath = [string](Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $graceful.Id)).ExecutablePath
    & node $Fixture create $GracefulDatabase graceful $reportedGracefulPath | Out-Null
    & pwsh -NoProfile -File $Worker -Mode Force -TaskId graceful -SqlitePath $GracefulDatabase -ScheduledTaskName test-graceful -DryRun
    $graceful.WaitForExit(5000) | Out-Null
    Assert-True (Test-Path -LiteralPath $GracefulMarker) 'Normal window-close request was not delivered.'

    $gracefulVaultRows = & node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(JSON.stringify(d.prepare('select * from game_executable_vault').all()));d.close()" $GracefulDatabase | ConvertFrom-Json
    Assert-True (@($gracefulVaultRows).Count -eq 0) 'Normally closed game unexpectedly queued vault protection.'

    [pscustomobject]@{ ok = $true; pathMismatchProtected = $true; exactPathClosed = $true; forcedGameQueued = $true; gracefulCloseRequested = $true; gracefulGameNotProtected = $true } | ConvertTo-Json -Compress
} finally {
    Get-Process -Name 'game-timer-fixture','game-timer-graceful-fixture' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
