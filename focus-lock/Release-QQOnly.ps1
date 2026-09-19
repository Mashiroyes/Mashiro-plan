$ErrorActionPreference='Stop'
$root='C:\ProgramData\CodexFocusLock'
$ep=Join-Path $root 'bilibili-qq-expiry.json'
$x=Get-Content -Raw $ep | ConvertFrom-Json
$x | Add-Member -NotePropertyName QQReleased -NotePropertyValue $true -Force
$x | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ep -Encoding UTF8
Copy-Item -LiteralPath 'D:\BaiduSyncdisk\Study\AI\codex\codex-study\focus-lock\FocusLock.ps1' -Destination 'C:\ProgramData\CodexFocusLock\FocusLock.ps1' -Force
$hosts="$env:SystemRoot\System32\drivers\etc\hosts"
$qq='(?i)\b(?:im\.qq\.com|pc\.qq\.com|dldir\.qq\.com|dldir1\.qq\.com|dldir1v6\.qq\.com|download\.imqq\.com)\b'
(Get-Content $hosts | Where-Object { $_ -notmatch $qq }) | Set-Content $hosts -Encoding utf8
foreach($r in @('HKLM:\SOFTWARE\Policies\Google\Chrome\URLBlocklist','HKLM:\SOFTWARE\Policies\Microsoft\Edge\URLBlocklist')) { if(Test-Path $r){ $p=Get-ItemProperty $r; foreach($q in $p.PSObject.Properties | ? Name -notmatch '^PS'){ if([string]$q.Value -match $qq){ Remove-ItemProperty $r $q.Name -ErrorAction SilentlyContinue } } } }
$ifeo='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options'; foreach($n in 'QQ.exe','QQNT.exe','TencentQQ.exe','QQLauncher.exe','QQScLauncher.exe','QQProtect.exe','QQSetup.exe','QQInstaller.exe','TIM.exe'){ $k=Join-Path $ifeo $n; if(Test-Path $k){ Remove-ItemProperty $k -Name Debugger -ErrorAction SilentlyContinue } }
& ipconfig /flushdns | Out-Null
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\ProgramData\CodexFocusLock\FocusLock.ps1' -Mode Reapply
Write-Output 'QQ released; Bilibili and hanime1.me retained.'
