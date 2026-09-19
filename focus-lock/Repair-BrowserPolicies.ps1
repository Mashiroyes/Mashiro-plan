$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required.'
}

$sourceScript = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\FocusLock.ps1'
$installedScript = 'C:\ProgramData\CodexFocusLock\FocusLock.ps1'
$statePath = 'C:\ProgramData\CodexFocusLock\state.json'
$resultPath = 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\repair-browser-policies-result.json'
$hostsPath = 'C:\Windows\System32\drivers\etc\hosts'
$hostsEnd = '# END CODEX FOCUS LOCK'

Copy-Item -LiteralPath $sourceScript -Destination $installedScript -Force
$hostsRaw = [IO.File]::ReadAllText($hostsPath)
$hostsLines = @($hostsRaw -split '\r?\n' | Where-Object { $_ -notmatch '(?i)hanime1\.me' })
$hostsClean = ($hostsLines -join "`r`n").TrimEnd() + "`r`n"
$hostsBlock = "0.0.0.0`thanime1.me`r`n0.0.0.0`twww.hanime1.me`r`n$hostsEnd"
$hostsUpdated = $hostsClean.Replace($hostsEnd, $hostsBlock)
[IO.File]::WriteAllText($hostsPath, $hostsUpdated, [Text.UTF8Encoding]::new($false))
& ipconfig.exe /flushdns | Out-Null

$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$groups = @($state.PolicyEntries | Group-Object Root)
$counts = [System.Collections.Generic.List[object]]::new()

foreach ($group in $groups) {
    $root = [string]$group.Name
    if (-not (Test-Path -Path $root)) {
        New-Item -Path $root -Force | Out-Null
    }
    $desired = @($group.Group | Select-Object -ExpandProperty Value -Unique)
    $current = Get-ItemProperty -Path $root
    $existingValues = @($current.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { [string]$_.Value })
    $usedNames = @($current.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' } | ForEach-Object { [int]$_.Name })
    $next = 9000
    foreach ($value in $desired) {
        if ($existingValues -contains $value) { continue }
        while ($usedNames -contains $next) { $next++ }
        New-ItemProperty -Path $root -Name ([string]$next) -Value ([string]$value) -PropertyType String -Force | Out-Null
        $usedNames += $next
        $existingValues += [string]$value
        $next++
    }
    $after = Get-ItemProperty -Path $root
    $valuesAfter = @($after.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { [string]$_.Value })
    $counts.Add([pscustomobject]@{
        Root = $root
        Total = $valuesAfter.Count
        Bilibili = @($valuesAfter | Where-Object { $_ -match 'bilibili|b23|bilivideo|hdslb' }).Count
        QQ = @($valuesAfter | Where-Object { $_ -match 'qq\.com' }).Count
        Hanime = @($valuesAfter | Where-Object { $_ -match 'hanime1' }).Count
    })
}

[pscustomobject]@{ CompletedAt = (Get-Date).ToString('o'); Counts = @($counts) } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
