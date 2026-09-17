[CmdletBinding()]
param(
    [ValidateSet('Reapply','Scan','Remove','Status')][string]$Mode = 'Status',
    [Parameter(Mandatory = $false)][string]$SqlitePath,
    [string]$StateRoot = (Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-block'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$MarkerStart = '# BEGIN MASHIROBOT BLOCK'
$MarkerEnd = '# END MASHIROBOT BLOCK'
$StatePath = Join-Path $StateRoot 'state.json'
$QuarantineRoot = Join-Path $StateRoot 'quarantine'
$DbHelper = Join-Path $PSScriptRoot 'block-db-v1.mjs'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$WorkerMutexName = 'Global\MashiroBot.PluginBlock.Worker'
$ClashReloadBudgetMs = 12000
$ClashReloadRetryDelayMs = 500

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $DryRun) { throw 'Block worker requires an elevated Administrator process.' }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $StatePath)) { return [pscustomobject][ordered]@{ IfeoBackups = @(); PolicyBackups = @(); ClashManagedDomains = @(); ClashReloadPending = $false; LegacyBilibiliDelegated = $false; LegacyBilibiliReleaseBefore = $null; UserProfile = $env:USERPROFILE; ClashRoot = $null; LastSync = $null } }
    $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $state.PSObject.Properties['IfeoBackups']) { $state | Add-Member -NotePropertyName IfeoBackups -NotePropertyValue @() }
    if ($null -eq $state.PSObject.Properties['PolicyBackups']) { $state | Add-Member -NotePropertyName PolicyBackups -NotePropertyValue @() }
    if ($null -eq $state.PSObject.Properties['ClashManagedDomains']) { $state | Add-Member -NotePropertyName ClashManagedDomains -NotePropertyValue @() }
    if ($null -eq $state.PSObject.Properties['ClashReloadPending']) { $state | Add-Member -NotePropertyName ClashReloadPending -NotePropertyValue $false }
    if ($null -eq $state.PSObject.Properties['LegacyBilibiliDelegated']) { $state | Add-Member -NotePropertyName LegacyBilibiliDelegated -NotePropertyValue $false }
    if ($null -eq $state.PSObject.Properties['LegacyBilibiliReleaseBefore']) { $state | Add-Member -NotePropertyName LegacyBilibiliReleaseBefore -NotePropertyValue $null }
    if ($null -eq $state.PSObject.Properties['UserProfile']) { $state | Add-Member -NotePropertyName UserProfile -NotePropertyValue $env:USERPROFILE }
    if ($null -eq $state.PSObject.Properties['ClashRoot']) { $state | Add-Member -NotePropertyName ClashRoot -NotePropertyValue $null }
    if ($null -eq $state.PSObject.Properties['LastSync']) { $state | Add-Member -NotePropertyName LastSync -NotePropertyValue $null }
    return $state
}

function Save-State($state) {
    if ($DryRun) { return }
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $temporary = "$StatePath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $state | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $StatePath -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Read-JsonObject([string]$path) {
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    try { return ($raw | ConvertFrom-Json) } catch {
        # Older workers could write the compatibility file concurrently and
        # leave two complete JSON objects concatenated. Keep the first object
        # so the new atomic writer can repair the file on this run.
        $boundary = [regex]::Match($raw, '(?m)^\}\s*\r?\n\s*\{')
        if (-not $boundary.Success) { throw }
        return ($raw.Substring(0, $boundary.Index + 1) | ConvertFrom-Json)
    }
}

function Save-JsonAtomic([string]$path, $value, [int]$depth = 8) {
    $temporary = "$path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $value | ConvertTo-Json -Depth $depth | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-Db([string]$dbMode) {
    if (-not $SqlitePath -or -not (Test-Path -LiteralPath $SqlitePath -PathType Leaf)) { throw "SQLite database not found: $SqlitePath" }
    $output = & $Node $DbHelper $dbMode $SqlitePath 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SQLite worker query failed: $output" }
    return @($output -join "" | ConvertFrom-Json)
}

function Remove-MarkedBlock([string]$raw) {
    $pattern = "(?ms)\r?\n?[ \t]*$([regex]::Escape($MarkerStart))[ \t]*\r?\n.*?[ \t]*$([regex]::Escape($MarkerEnd))[ \t]*\r?\n?"
    return [regex]::Replace($raw, $pattern, "`r`n")
}

function Write-Text([string]$path, [string]$text) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $old = [IO.File]::ReadAllText($path)
    if ($old -eq $text) { return $false }
    if (-not $DryRun) { [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false)) }
    return $true
}

function New-DomainSet($rows, $softwareConfig) {
    $domains = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in @($rows)) {
        if ($row.kind -eq 'website') {
            [void]$domains.Add([string]$row.target_key)
            if ($row.target_key -eq 'bilibili.com') {
                foreach ($related in @('bilivideo.com','hdslb.com','b23.tv')) { [void]$domains.Add($related) }
            }
        }
        if ($row.kind -eq 'software') {
            $item = $softwareConfig | Where-Object { $_.key -eq $row.target_key } | Select-Object -First 1
            if ($item) { foreach ($domain in @($item.downloadDomains)) { [void]$domains.Add([string]$domain) } }
        }
    }
    return @($domains | Sort-Object)
}

function Expand-ReleasedDomains($releasedDomains) {
    $expanded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($domain in @($releasedDomains)) {
        [void]$expanded.Add([string]$domain)
        if ($domain -eq 'bilibili.com') {
            foreach ($related in @('bilivideo.com','hdslb.com','b23.tv')) { [void]$expanded.Add($related) }
        }
    }
    return @($expanded | Sort-Object)
}

function Get-SoftwareConfig {
    return @(
        [pscustomobject]@{ key='qq'; downloadDomains=@('im.qq.com','pc.qq.com','dldir.qq.com','dldir1.qq.com','dldir1v6.qq.com','download.imqq.com'); processNames=@('QQ.exe','QQNT.exe','TencentQQ.exe','QQLauncher.exe','QQScLauncher.exe','QQProtect.exe','TIM.exe'); installerPatterns=@('QQ*.exe','QQ*.msi','QQNT*.exe','TIM*.exe','TIM*.msi'); executablePatterns=@('*\Tencent\QQ*\*.exe','*\Tencent\QQNT\*.exe','*\Tencent\TIM\*.exe') },
        [pscustomobject]@{ key='bilibili'; downloadDomains=@('bilibili.com','bilivideo.com','hdslb.com','b23.tv'); processNames=@(); installerPatterns=@('哔哩哔哩*.exe','Bilibili*.exe'); executablePatterns=@() }
    )
}

function Test-ReleasedDomain([string]$hostName, $releasedDomains) {
    $candidate = $hostName.Trim().TrimEnd('.').ToLowerInvariant()
    foreach ($domain in @($releasedDomains)) {
        $root = ([string]$domain).Trim().TrimEnd('.').ToLowerInvariant()
        if ($candidate -eq $root -or $candidate.EndsWith('.' + $root)) { return $true }
    }
    return $false
}

function Remove-ReleasedHosts([string]$raw, $releasedDomains) {
    if (-not @($releasedDomains).Count) { return $raw }
    $kept = foreach ($line in ($raw -split '\r?\n')) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { $line; continue }
        $tokens = @($trimmed -split '\s+' | Where-Object { $_ })
        if ($tokens.Count -lt 2) { $line; continue }
        $blocked = $false
        foreach ($hostName in @($tokens[1..($tokens.Count - 1)])) {
            if (Test-ReleasedDomain $hostName $releasedDomains) { $blocked = $true; break }
        }
        if (-not $blocked) { $line }
    }
    return ($kept -join "`r`n")
}

function Set-HostsRules($domains, $releasedDomains) {
    $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $raw = [IO.File]::ReadAllText($path)
    $clean = Remove-ReleasedHosts (Remove-MarkedBlock $raw) $releasedDomains
    $lines = @($MarkerStart) + @($domains | ForEach-Object { "0.0.0.0`t$_"; "0.0.0.0`twww.$_" }) + @($MarkerEnd)
    return Write-Text $path (($clean.TrimEnd() + "`r`n`r`n" + ($lines -join "`r`n") + "`r`n"))
}

function Remove-ReleasedClashRules([string]$raw, $releasedDomains) {
    $result = $raw
    foreach ($domain in @($releasedDomains)) {
        $escaped = [regex]::Escape(([string]$domain).Trim().TrimEnd('.'))
        $pattern = "(?im)^[ \t]*-[ \t]*DOMAIN(?:-SUFFIX)?[ \t]*,[ \t]*$escaped[ \t]*,[ \t]*REJECT[ \t]*(?:\r?\n)?"
        $result = [regex]::Replace($result, $pattern, '')
    }
    return $result
}

function Test-ClashRuleExists([string]$raw, [string]$domain) {
    $escaped = [regex]::Escape($domain.Trim().TrimEnd('.'))
    return [regex]::IsMatch($raw, "(?im)^[ \t]*-[ \t]*DOMAIN(?:-SUFFIX)?[ \t]*,[ \t]*$escaped[ \t]*,[ \t]*REJECT[ \t]*$")
}

function Add-YamlBlock([string]$raw, $rules) {
    $clean = Remove-MarkedBlock $raw
    if ($clean -match '(?m)^rules:\s*$') {
        $block = @($MarkerStart) + @($rules | ForEach-Object { "- $_" }) + @($MarkerEnd)
        return [regex]::Replace($clean, '(?m)^rules:\s*$', "rules:`r`n" + ($block -join "`r`n"), 1)
    }
    if ($clean -match '(?m)^prepend:\s*(?:\[\])?\s*$') {
        $block = @("  $MarkerStart") + @($rules | ForEach-Object { "  - $_" }) + @("  $MarkerEnd")
        $indented = $block -join "`r`n"
        return [regex]::Replace($clean, '(?m)^prepend:\s*(?:\[\])?\s*$', "prepend:`r`n$indented", 1)
    }
    $block = @("  $MarkerStart") + @($rules | ForEach-Object { "  - $_" }) + @("  $MarkerEnd")
    return "prepend:`r`n" + ($block -join "`r`n") + "`r`n`r`n" + $clean.TrimStart()
}

function Get-ClashPaths($state) {
    $root = [string]$state.ClashRoot
    if (-not $root) { $root = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'io.github.clash-verge-rev.clash-verge-rev' }
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    $profiles = Join-Path $root 'profiles'
    $registry = Join-Path $root 'profiles.yaml'
    if (-not (Test-Path -LiteralPath $profiles) -or -not (Test-Path -LiteralPath $registry -PathType Leaf)) { return @() }
    $rawRegistry = [IO.File]::ReadAllText($registry)
    $currentUid = if ($rawRegistry -match '(?m)^current:\s*([^\s#]+)') { $Matches[1] } else { $null }
    $items = @()
    $current = $null
    foreach ($line in ($rawRegistry -split '\r?\n')) {
        if ($line -match '^\s*-\s+uid:\s*([^\s#]+)') {
            if ($null -ne $current) { $items += [pscustomobject]$current }
            $current = [ordered]@{ Uid=$Matches[1]; Type=$null; Name=$null; File=$null; Rules=$null }
            continue
        }
        if ($null -eq $current) { continue }
        if ($line -match '^\s+type:\s*([^\s#]+)') { $current.Type = $Matches[1]; continue }
        if ($line -match '^\s+name:\s*(.+?)\s*$') { $current.Name = $Matches[1].Trim([char[]]@(' ',[char]39,[char]34)); continue }
        if ($line -match '^\s+file:\s*([^\s#]+)') { $current.File = $Matches[1]; continue }
        if ($line -match '^\s+rules:\s*([^\s#]+)') { $current.Rules = $Matches[1]; continue }
    }
    if ($null -ne $current) { $items += [pscustomobject]$current }
    $activeRemote = $items | Where-Object { $_.Type -eq 'remote' -and $_.Uid -eq $currentUid } | Select-Object -First 1
    $ruleIds = if ($activeRemote) { @($activeRemote.Rules | Where-Object { $_ }) } else { @() }
    # Only edit the persistent rule-provider source. Clash regenerates
    # clash-verge*.yaml and strips comments; editing those generated files
    # would look like a change on every scan and restart the core repeatedly.
    $paths = foreach ($item in @($items | Where-Object { $_.Type -eq 'rules' -and $ruleIds -contains $_.Uid })) {
        $candidate = Join-Path $profiles $item.File
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
    }
    return @($paths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Unique)
}

function Get-ClashGeneratedPaths($state) {
    $root = [string]$state.ClashRoot
    if (-not $root) { $root = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'io.github.clash-verge-rev.clash-verge-rev' }
    return @(
        (Join-Path $root 'clash-verge.yaml'),
        (Join-Path $root 'clash-verge-check.yaml')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
}

function Invoke-ClashHttpReload([string]$bodyJson, [int]$timeoutMs) {
    $handler = [Net.Http.SocketsHttpHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds($timeoutMs)
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Put, 'http://127.0.0.1:9097/configs?force=true')
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', 'set-your-secret')
    $request.Content = [Net.Http.StringContent]::new($bodyJson, [Text.Encoding]::UTF8, 'application/json')
    $response = $null
    try {
        $response = $client.Send($request)
        $statusCode = [int]$response.StatusCode
        if ($statusCode -notin @(200,204)) { return [pscustomobject]@{ Ok=$false; Error="HTTP controller returned status $statusCode." } }
        return [pscustomobject]@{ Ok=$true; Error=$null }
    } catch {
        return [pscustomobject]@{ Ok=$false; Error=$_.Exception.Message }
    } finally {
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

function Invoke-ClashPipeReload([byte[]]$bodyBytes, [byte[]]$headerBytes, [int]$timeoutMs) {
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'verge-mihomo', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
        $connectTimeoutMs = [Math]::Min(1200, [Math]::Max(100, $timeoutMs))
        $pipe.Connect($connectTimeoutMs)
        $pipe.Write($headerBytes,0,$headerBytes.Length)
        $pipe.Write($bodyBytes,0,$bodyBytes.Length)
        $pipe.Flush()
        $buffer = New-Object byte[] 8192
        $read = $pipe.ReadAsync($buffer,0,$buffer.Length)
        $responseTimeoutMs = [Math]::Min(2500, [Math]::Max(100, $timeoutMs))
        if (-not $read.Wait($responseTimeoutMs)) { throw 'Clash reload response timed out.' }
        $response = [Text.Encoding]::UTF8.GetString($buffer,0,$read.Result)
        if ($response -notmatch '^HTTP/1\.1 (?:200|204)') { throw "Clash reload failed: $($response.Split("`r`n")[0])" }
        return [pscustomobject]@{ Ok=$true; Error=$null }
    } catch {
        return [pscustomobject]@{ Ok=$false; Error=$_.Exception.Message }
    } finally { $pipe.Dispose() }
}

function Invoke-ClashReload([string]$configPath) {
    if ($DryRun -or -not $configPath) { return [pscustomobject]@{ Ok=$true; Error=$null } }
    $bodyJson = @{ path=$configPath } | ConvertTo-Json -Compress
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($bodyJson)
    $headers = "PUT /configs?force=true HTTP/1.1`r`nHost: localhost`r`nAuthorization: Bearer set-your-secret`r`nContent-Type: application/json`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $lastHttpError = 'The loopback HTTP controller was unavailable.'
    $lastPipeError = 'The verge-mihomo named pipe was unavailable.'
    while ($timer.ElapsedMilliseconds -lt $ClashReloadBudgetMs) {
        $remainingMs = [int]($ClashReloadBudgetMs - $timer.ElapsedMilliseconds)
        if ($remainingMs -le 0) { break }
        $httpResult = Invoke-ClashHttpReload $bodyJson ([Math]::Min(1500, [Math]::Max(100, $remainingMs)))
        if ($httpResult.Ok) { return $httpResult }
        $lastHttpError = $httpResult.Error
        $remainingMs = [int]($ClashReloadBudgetMs - $timer.ElapsedMilliseconds)
        if ($remainingMs -le 0) { break }
        $pipeResult = Invoke-ClashPipeReload $bodyBytes $headerBytes $remainingMs
        if ($pipeResult.Ok) { return $pipeResult }
        $lastPipeError = $pipeResult.Error
        $remainingMs = [int]($ClashReloadBudgetMs - $timer.ElapsedMilliseconds)
        if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([Math]::Min($ClashReloadRetryDelayMs, $remainingMs)) }
    }
    return [pscustomobject]@{ Ok=$false; Error="HTTP: $lastHttpError; pipe: $lastPipeError" }
}

function Set-ClashRules($domains, $releasedDomains, $state) {
    $previous = @($state.ClashManagedDomains)
    $removeDomains = @(
        @($releasedDomains) + @($previous | Where-Object { $domains -notcontains $_ }) |
        Where-Object { $_ } | Sort-Object -Unique
    )
    $changed = $false
    foreach ($path in @(Get-ClashPaths $state)) {
        $raw = Remove-ReleasedClashRules (Remove-MarkedBlock ([IO.File]::ReadAllText($path))) $removeDomains
        $missing = @($domains | Where-Object { -not (Test-ClashRuleExists $raw $_) })
        $updated = if ($missing.Count) { Add-YamlBlock $raw @($missing | ForEach-Object { "DOMAIN-SUFFIX,$_,REJECT" }) } else { $raw }
        $changed = (Write-Text $path $updated) -or $changed
    }
    $generatedPaths = @(Get-ClashGeneratedPaths $state)
    if ($changed) {
        foreach ($path in $generatedPaths) {
            $raw = Remove-ReleasedClashRules (Remove-MarkedBlock ([IO.File]::ReadAllText($path))) $removeDomains
            $missing = @($domains | Where-Object { -not (Test-ClashRuleExists $raw $_) })
            $updated = if ($missing.Count) { Add-YamlBlock $raw @($missing | ForEach-Object { "DOMAIN-SUFFIX,$_,REJECT" }) } else { $raw }
            [void](Write-Text $path $updated)
        }
    }
    $reloadNeeded = $changed -or [bool]$state.ClashReloadPending -or ($state.LastSync -and -not [bool]$state.LastSync.ok)
    if ($reloadNeeded) {
        $runtimeConfig = $generatedPaths | Where-Object { [IO.Path]::GetFileName($_) -eq 'clash-verge.yaml' } | Select-Object -First 1
        $reloadResult = Invoke-ClashReload $runtimeConfig
        $state.ClashReloadPending = -not [bool]$reloadResult.Ok
        if (-not $reloadResult.Ok) {
            Save-State $state
            throw "Clash configuration was updated, but both reload transports remained unavailable after retries. Last error: $($reloadResult.Error)"
        }
    }
    $state.ClashManagedDomains = @($domains)
    return $changed
}

function Set-LegacyBilibiliDelegation($state, [bool]$enabled) {
    $expiryPath = 'C:\ProgramData\CodexFocusLock\bilibili-qq-expiry.json'
    if (-not (Test-Path -LiteralPath $expiryPath -PathType Leaf)) { return }
    $legacy = Read-JsonObject $expiryPath
    if ($enabled) {
        if (-not $state.LegacyBilibiliDelegated) {
            $state.LegacyBilibiliReleaseBefore = if ($legacy.PSObject.Properties['BilibiliReleaseUntil']) { [string]$legacy.BilibiliReleaseUntil } else { $null }
        }
        $legacy | Add-Member -NotePropertyName BilibiliReleaseUntil -NotePropertyValue '2099-12-31T23:59:59+08:00' -Force
        $legacy | Add-Member -NotePropertyName BilibiliClashRetained -NotePropertyValue $false -Force
        $state.LegacyBilibiliDelegated = $true
    } elseif ($state.LegacyBilibiliDelegated) {
        $legacy | Add-Member -NotePropertyName BilibiliReleaseUntil -NotePropertyValue $state.LegacyBilibiliReleaseBefore -Force
        $state.LegacyBilibiliDelegated = $false
    } else { return }
    if (-not $DryRun) { Save-JsonAtomic $expiryPath $legacy 8 }
}

function Remove-ReleasedBrowserPolicies($releasedDomains) {
    if (-not @($releasedDomains).Count) { return }
    $roots = @('HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist','HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist')
    foreach ($root in $roots) {
        if (-not (Test-Path -Path $root)) { continue }
        $existing = Get-ItemProperty -Path $root
        foreach ($property in @($existing.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' })) {
            $value = [string]$property.Value
            $hostName = $null
            if ($value -match '^\*://(?:\*\.)?([^/]+)/') { $hostName = $Matches[1] }
            if ($hostName -and (Test-ReleasedDomain $hostName $releasedDomains) -and -not $DryRun) {
                Remove-ItemProperty -Path $root -Name $property.Name -ErrorAction SilentlyContinue
            }
        }
    }
}

function Set-BrowserPolicies($domains, $state) {
    $roots = @('HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist','HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist')
    foreach ($root in $roots) {
        if (-not $DryRun) { New-Item -Path $root -Force | Out-Null }
        $existing = if (Test-Path -Path $root) { Get-ItemProperty -Path $root } else { $null }
        $values = @($existing.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { [string]$_.Value })
        $used = @($existing.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' } | ForEach-Object { [int]$_.Name })
        $next = 9000
        foreach ($domain in @($domains)) {
            foreach ($pattern in @("*://$domain/*", "*://*.$domain/*")) {
                if ($values -contains $pattern) { continue }
                while ($used -contains $next) { $next++ }
                $entry = [pscustomobject]@{ Root=$root; Name=[string]$next; Value=$pattern }
                if (-not ($state.PolicyBackups | Where-Object { $_.Root -eq $root -and $_.Name -eq [string]$next })) { $state.PolicyBackups += $entry }
                if (-not $DryRun) { New-ItemProperty -Path $root -Name ([string]$next) -Value $pattern -PropertyType String -Force | Out-Null }
                $values += $pattern
                $used += $next
                $next++
            }
        }
    }
}

function Restore-BrowserPolicies($state) {
    foreach ($entry in @($state.PolicyBackups)) {
        if ($DryRun -or -not (Test-Path -Path $entry.Root)) { continue }
        $current = Get-ItemPropertyValue -Path $entry.Root -Name $entry.Name -ErrorAction SilentlyContinue
        if ([string]$current -eq [string]$entry.Value) { Remove-ItemProperty -Path $entry.Root -Name $entry.Name -ErrorAction SilentlyContinue }
    }
    $state.PolicyBackups = @()
}

function Restore-ClashRules($state) {
    $changed = $false
    $managed = @($state.ClashManagedDomains)
    foreach ($path in @(@(Get-ClashPaths $state) + @(Get-ClashGeneratedPaths $state))) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $raw = Remove-ReleasedClashRules (Remove-MarkedBlock ([IO.File]::ReadAllText($path))) $managed
        $changed = (Write-Text $path $raw) -or $changed
    }
    if ($changed) {
        $runtimeConfig = @(Get-ClashGeneratedPaths $state) | Where-Object { [IO.Path]::GetFileName($_) -eq 'clash-verge.yaml' } | Select-Object -First 1
        Invoke-ClashReload $runtimeConfig
    }
    $state.ClashManagedDomains = @()
}

function Set-ImageBlocks($rows, $config, $state) {
    $wanted = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($row in @($rows | Where-Object kind -eq 'software')) { $item = $config | Where-Object key -eq $row.target_key | Select-Object -First 1; if ($item) { foreach ($name in @($item.processNames)) { [void]$wanted.Add($name) } } }
    $backup = @($state.IfeoBackups | Where-Object { $wanted -contains $_.Image })
    foreach ($name in $wanted) {
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$name"
        if (-not ($backup | Where-Object Image -eq $name)) {
            $entry = [pscustomobject]@{ Image=$name; KeyExisted=(Test-Path $key); DebuggerExisted=($null -ne (Get-ItemPropertyValue -Path $key -Name Debugger -ErrorAction SilentlyContinue)); DebuggerValue=(Get-ItemPropertyValue -Path $key -Name Debugger -ErrorAction SilentlyContinue) }
            $state.IfeoBackups += $entry
        }
        if (-not $DryRun) { New-Item -Path $key -Force | Out-Null; New-ItemProperty -Path $key -Name Debugger -Value "$env:SystemRoot\System32\cmd.exe /d /c exit" -PropertyType String -Force | Out-Null }
    }
}

function Restore-ImageBlocks($state) {
    foreach ($backup in @($state.IfeoBackups)) {
        $key = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$($backup.Image)"
        if ($DryRun -or -not (Test-Path $key)) { continue }
        if ($backup.DebuggerExisted) { New-ItemProperty -Path $key -Name Debugger -Value ([string]$backup.DebuggerValue) -PropertyType String -Force | Out-Null } else { Remove-ItemProperty -Path $key -Name Debugger -ErrorAction SilentlyContinue }
        if (-not $backup.KeyExisted -and @(Get-Item -Path $key | Select-Object -ExpandProperty Property).Count -eq 0) { Remove-Item -Path $key -Force -ErrorAction SilentlyContinue }
    }
    $state.IfeoBackups = @()
}

function Stop-BlockedProcesses($rows, $config) {
    $items = foreach ($row in @($rows | Where-Object kind -eq 'software')) { $config | Where-Object key -eq $row.target_key | Select-Object -First 1 }
    foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
        $image = $process.ProcessName + '.exe'
        $item = $items | Where-Object { $_.processNames -contains $image } | Select-Object -First 1
        if (-not $item) { continue }
        $path = $null
        try { $path = $process.MainModule.FileName } catch { continue }
        if (-not $path -or -not (@($item.executablePatterns | Where-Object { $path -like $_ }).Count)) { continue }
        if (-not $DryRun) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
}

function Move-Installers($rows, $config, $state) {
    $userProfile = [string]$state.UserProfile
    if (-not $userProfile) { return }
    $patterns = @()
    foreach ($row in @($rows | Where-Object kind -eq 'software')) { $item = $config | Where-Object key -eq $row.target_key | Select-Object -First 1; if ($item) { $patterns += @($item.installerPatterns) } }
    if (-not $patterns.Count) { return }
    if (-not $DryRun) { New-Item -ItemType Directory -Path $QuarantineRoot -Force | Out-Null }
    foreach ($dir in @((Join-Path $userProfile 'Downloads'), (Join-Path $userProfile 'Desktop'))) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($pattern in $patterns) {
            foreach ($file in @(Get-ChildItem -LiteralPath $dir -File -Filter $pattern -ErrorAction SilentlyContinue)) {
                if ($DryRun) { continue }
                $destination = Join-Path $QuarantineRoot ($file.Name + '.' + [guid]::NewGuid().ToString('N'))
                Move-Item -LiteralPath $file.FullName -Destination $destination -Force
                Set-Content -LiteralPath ($destination + '.origin.txt') -Value $file.FullName -Encoding UTF8
            }
        }
    }
}

function Invoke-Reapply {
    Assert-Administrator
    $state = Read-State
    [void](Invoke-Db 'expire')
    $rows = @(Invoke-Db 'active')
    $releasedRows = @(Invoke-Db 'released')
    $releasedDomains = @(Expand-ReleasedDomains @($releasedRows | ForEach-Object { [string]$_.target_key } | Sort-Object -Unique))
    $config = Get-SoftwareConfig
    $domains = @(New-DomainSet $rows $config)
    $pluginManagesBilibili = @($rows + $releasedRows | Where-Object { $_.target_key -eq 'bilibili.com' }).Count -gt 0 -or [bool]$state.LegacyBilibiliDelegated
    Set-LegacyBilibiliDelegation $state $pluginManagesBilibili
    Set-HostsRules $domains $releasedDomains | Out-Null
    Set-ClashRules $domains $releasedDomains $state | Out-Null
    Restore-BrowserPolicies $state
    Remove-ReleasedBrowserPolicies $releasedDomains
    Set-BrowserPolicies $domains $state
    Restore-ImageBlocks $state
    Set-ImageBlocks $rows $config $state
    Stop-BlockedProcesses $rows $config
    Move-Installers $rows $config $state
    $state | Add-Member -NotePropertyName LastSync -NotePropertyValue ([ordered]@{
        ok = $true
        mode = $Mode
        completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        ruleCount = $rows.Count
        domainCount = $domains.Count
        releasedDomainCount = $releasedDomains.Count
        error = $null
    }) -Force
    Save-State $state
    [ordered]@{ ok=$true; mode='Reapply'; ruleCount=$rows.Count; domainCount=$domains.Count; releasedDomainCount=$releasedDomains.Count; dryRun=[bool]$DryRun } | ConvertTo-Json -Compress
}

function Invoke-Remove {
    Assert-Administrator
    $state = Read-State
    $hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    if (Test-Path -LiteralPath $hosts) { Write-Text $hosts (Remove-MarkedBlock ([IO.File]::ReadAllText($hosts))) | Out-Null }
    Restore-ClashRules $state
    Set-LegacyBilibiliDelegation $state $false
    Restore-BrowserPolicies $state
    Restore-ImageBlocks $state
    Save-State $state
    [ordered]@{ ok=$true; mode='Remove'; dryRun=[bool]$DryRun } | ConvertTo-Json -Compress
}

function Invoke-Status {
    $state = Read-State
    [ordered]@{ ok=$true; mode='Status'; statePath=$StatePath; stateExists=(Test-Path -LiteralPath $StatePath); dryRun=[bool]$DryRun; ifeoBackupCount=@($state.IfeoBackups).Count; lastSync=$state.LastSync } | ConvertTo-Json -Compress
}

$workerMutex = $null
$workerMutexHeld = $false
if (-not $SqlitePath -and $Mode -ne 'Status') { throw 'SqlitePath is required.' }
try {
    if ($Mode -ne 'Status' -and -not $DryRun) {
        $workerMutex = [Threading.Mutex]::new($false, $WorkerMutexName)
        $workerMutexHeld = $workerMutex.WaitOne([TimeSpan]::FromSeconds(30))
        if (-not $workerMutexHeld) { throw 'Timed out waiting for another block worker operation to finish.' }
    }
    switch ($Mode) { 'Reapply' { Invoke-Reapply }; 'Scan' { Invoke-Reapply }; 'Remove' { Invoke-Remove }; 'Status' { Invoke-Status } }
} catch {
    if ($Mode -in @('Reapply','Scan') -and -not $DryRun) {
        try {
            $failedState = Read-State
            $failedState | Add-Member -NotePropertyName LastSync -NotePropertyValue ([ordered]@{
                ok = $false
                mode = $Mode
                completedAt = [DateTimeOffset]::UtcNow.ToString('o')
                ruleCount = $null
                domainCount = $null
                error = $_.Exception.Message
            }) -Force
            Save-State $failedState
        } catch {}
    }
    throw
} finally {
    if ($workerMutexHeld) { $workerMutex.ReleaseMutex() }
    if ($workerMutex) { $workerMutex.Dispose() }
}
