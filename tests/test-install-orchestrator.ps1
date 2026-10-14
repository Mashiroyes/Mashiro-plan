$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$Script=Join-Path (Split-Path -Parent $PSScriptRoot) 'core\config\install-new-computer.ps1';$Text=Get-Content -LiteralPath $Script -Raw -Encoding UTF8
foreach($Required in @('preflight','configure','backup','adapter','gateway-watchdog','core-features','optional-features','gateway-start','static-verify','acceptance','report')){if($Text-notmatch [regex]::Escape($Required)){throw "Missing deployment phase $Required"}}
if($Text-notmatch 'Invoke-Checked'){throw 'Every child installer must cross the checked-process boundary.'};if($Text-notmatch '\$Resume-and\$s\.phases\.\$n\.status-eq''passed'''){throw 'Resume must skip passed phases.'};if($Text-notmatch "Profile-eq'Core'"){throw 'Core profile must skip optional controls.'}
if($Text-notmatch 'reused-existing-machine-config'){throw 'Install must reuse an existing valid machine configuration without requiring the WeChat target again.'}
if($Text-notmatch 'reused-verified-runtime-descriptor'){throw 'Resume must recover a verified runtime descriptor after an interrupted report write.'}
if($Text-notmatch 'Install-Or-ReapplyFocusLock'){throw 'Install must handle an existing FocusLock without deleting its state.'}
if($Text-notmatch "\{'Reapply'\}else\{'Install'\}"){throw 'Existing FocusLock must be reapplied rather than reinstalled.'}
if($Text-notmatch 'Wait-GatewayReady'){throw 'Install must wait for verified gateway readiness before runtime health checks.'}
if($Text-notmatch 'TimeoutSeconds=60'){throw 'Gateway readiness wait must be bounded.'}
if($Text-notmatch 'Test-OptionalFeaturesCurrent'){throw 'Resume must detect drift between source and installed optional workers.'}
if($Text-notmatch 'installed-worker-drift-detected'){throw 'Detected worker drift must make the optional phase runnable again.'}
$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile($Script,[ref]$tokens,[ref]$errors);if($errors.Count){throw($errors.Message-join'; ')}
Write-Output 'PASS: phase-based installer contract'
