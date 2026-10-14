[CmdletBinding()]
param(
 [ValidateSet('Capture','PrepareAndStart','LaunchInteractive','Reconcile','Watch','Resume','Recover','Status','ManualRestore','ManualProtect','MaintenanceRestore')][string]$Mode='Status',
 [Parameter(Mandatory=$true)][string]$SqlitePath,[string]$SessionId,[string]$InstallerPath,[string]$NodePath='node',
 [string]$StateRoot=(Join-Path $env:ProgramData 'MashiroBot\mashirobot-plugin-game-timer\qq'),
 [string]$FocusLockRoot=(Join-Path $env:ProgramData 'CodexFocusLock'),
 [string]$HostsPath=(Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'),
 [string]$ExecutableContainerRoot,[string]$ContainerConfigPath,
 [string]$Now,[switch]$FixtureMode,[switch]$SkipSignatureValidation,[string]$FixtureInstallPath,[string]$FixtureDownloadsPath
)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=$OutputEncoding
$helper=Join-Path $PSScriptRoot 'qq-session-db-v1.mjs'; $authPath=Join-Path $FocusLockRoot 'qq-play-authorization.json'
$containerHelper=Join-Path $PSScriptRoot 'qq-executable-container-v2.ps1';if(-not(Test-Path -LiteralPath $containerHelper -PathType Leaf)){throw 'QQ executable container helper is missing.'};. $containerHelper
$focusScript=Join-Path $FocusLockRoot 'FocusLock.ps1'; $vaultRoot=Join-Path $StateRoot 'vault'; $stageRoot=Join-Path $StateRoot 'staging'
if(-not $ContainerConfigPath){$ContainerConfigPath=Join-Path $StateRoot 'runtime-cache.json'}
$script:containerKeyProtector=if($FixtureMode){{param([byte[]]$key)[byte[]]$key.Clone()}}else{$null}
$script:containerKeyUnprotector=if($FixtureMode){{param([byte[]]$wrapped)[byte[]]$wrapped.Clone()}}else{$null}
$timeoutPrompt=Join-Path $FocusLockRoot 'TimeoutReadingPrompt.ps1'
$statusPath=Join-Path $StateRoot 'last-status.json';$launchStatusPath=Join-Path $StateRoot 'launch-status.json';$launchTaskName='MashiroBot-QQSession-Launch'; $clients=@('QQ.exe','QQNT.exe','TencentQQ.exe','QQLauncher.exe','QQScLauncher.exe','QQProtect.exe','TIM.exe')
$domains=@('im.qq.com','pc.qq.com','dldir.qq.com','dldir1.qq.com','dldir1v6.qq.com','download.imqq.com')
$installerPattern='^(QQ|QQNT|TencentQQ|QQInstaller|QQSetup|TIM)(?=[0-9._ -]|$).*\.(exe|msi)$'
$clock=if($Now){[DateTimeOffset]::Parse($Now).ToUniversalTime()}else{[DateTimeOffset]::UtcNow}
function Refresh-Clock { if(-not $Now){$script:clock=[DateTimeOffset]::UtcNow} }
function Test-QQSessionWindow($session) {
 if(-not $session){throw 'QQ session is missing.'}
 $china=[TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
 if([string]$session.windowPolicy -eq 'sunday-4h'){
  if([int]$session.playMinutes-lt1-or[int]$session.playMinutes-gt240){throw 'Sunday QQ session must be between 1 and 240 minutes.'}
  $requested=[TimeZoneInfo]::ConvertTime([DateTimeOffset]::Parse([string]$session.requestedAt),$china)
  $requestedDate=$requested.ToString('yyyy-MM-dd')
  if($requested.DayOfWeek-ne[DayOfWeek]::Sunday-or[string]$session.specialLocalDate-ne$requestedDate){throw 'Sunday QQ session policy is invalid.'}
  $local=[TimeZoneInfo]::ConvertTime($clock,$china)
  $midnight=[DateTimeOffset]::new($local.Year,$local.Month,$local.Day,0,0,0,$local.Offset).AddDays(1)
  if($local.DayOfWeek-ne[DayOfWeek]::Sunday){throw 'Sunday QQ session cannot start after Monday midnight.'}
  if($session.playEndsAt){
   $sessionEnd=[DateTimeOffset]::Parse([string]$session.playEndsAt).ToUniversalTime()
   if($sessionEnd-gt$midnight.ToUniversalTime()){throw 'Sunday QQ session must end before Monday midnight.'}
  }
  return $true
 }
 if([string]$session.windowPolicy -and[string]$session.windowPolicy-ne'daily'){throw 'QQ session window policy is invalid.'}
 $local=[TimeZoneInfo]::ConvertTime($clock,$china)
 $close=[DateTimeOffset]::new($local.Year,$local.Month,$local.Day,22,0,0,$local.Offset)
 $sessionEnd=if($session.playEndsAt){[DateTimeOffset]::Parse([string]$session.playEndsAt).ToUniversalTime()}else{$clock.AddMinutes([int]$session.playMinutes)}
 if($local.Hour -lt 12 -or $local.Hour -ge 22 -or $sessionEnd -gt $close.ToUniversalTime()){throw 'QQ only allows sessions daily from 12:00 through 22:00 China Standard Time.'}
 $true
}
function B64($v){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 12 -Compress)))}
function Db($command,$payload=$null){
 $args=@($helper,$command,$SqlitePath); if($null-ne $payload){$args+=B64 $payload}; $raw=& $NodePath @args 2>&1
 if($LASTEXITCODE-ne 0){throw "QQ database helper failed ($command): $($raw-join [Environment]::NewLine)"}
 $text=($raw|Where-Object{$_-notmatch '^\(node:'})-join ''; if($text){$text|ConvertFrom-Json -DateKind String}
}
function Session { if($SessionId){Db 'get' @{id=$SessionId}}else{Db 'latest-open'} }
function Save-Atomic($path,$value){New-Item -ItemType Directory -Path (Split-Path -Parent $path)-Force|Out-Null;$tmp="$path.$([guid]::NewGuid().ToString('N')).tmp";$value|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $tmp -Encoding UTF8;[IO.File]::Move($tmp,$path,$true)}
function Authorize($session,[Nullable[DateTimeOffset]]$install,[Nullable[DateTimeOffset]]$play){
 if(-not $install -and -not $play -and (Test-Path -LiteralPath $authPath)){
  try{
   $existing=Get-Content -Raw -LiteralPath $authPath -Encoding UTF8|ConvertFrom-Json -DateKind String
   $existingId=[string]$existing.SessionId;$incomingId=if($session){[string]$session.id}else{''}
   $existingPlayUntil=if($existing.QQPlayUntil){[DateTimeOffset]::Parse([string]$existing.QQPlayUntil).ToUniversalTime()}else{$clock.AddSeconds(-1)}
   if($existingId -and $existingId -ne $incomingId -and $clock -lt $existingPlayUntil){return}
  }catch{}
 }
 Save-Atomic $authPath ([ordered]@{SessionId=if($session){[string]$session.id}else{$null};QQInstallUntil=if($install){$install.ToUniversalTime().ToString('o')}else{$clock.AddSeconds(-1).ToString('o')};QQPlayUntil=if($play){$play.ToUniversalTime().ToString('o')}else{$clock.AddSeconds(-1).ToString('o')};UpdatedAt=$clock.ToString('o')})
}
function Auth {if(Test-Path -LiteralPath $authPath){try{Get-Content -Raw -LiteralPath $authPath -Encoding UTF8|ConvertFrom-Json -DateKind String}catch{$null}}}
function Play-Allowed($session){$a=Auth;if(-not $a-or-not $session-or [string]$a.SessionId-ne[string]$session.id){return $false};try{$clock-lt[DateTimeOffset]::Parse([string]$a.QQPlayUntil).ToUniversalTime()}catch{$false}}
function Manual-Allowed {$a=Auth;if(-not $a -or [string]$a.SessionId -ne 'manual-temporary-release'){return $false};try{$clock -lt [DateTimeOffset]::Parse([string]$a.QQPlayUntil).ToUniversalTime()}catch{$false}}
function Apply-Focus {if($FixtureMode){return};if(-not(Test-Path -LiteralPath $focusScript)){throw 'CodexFocusLock script is missing.'};& $focusScript -Mode Reapply|Out-Null}
function Submit-TimeoutReading($session){
 if(-not $session-or-not $session.playEndsAt-or-not(Test-Path -LiteralPath $timeoutPrompt -PathType Leaf)){return}
 $eventKey="qq:{0}:{1}" -f [string]$session.id,[string]$session.playEndsAt
 if($FixtureMode){& $timeoutPrompt -Mode Submit -EventKey $eventKey -FixtureMode | Out-Null}
 else{& $timeoutPrompt -Mode Submit -EventKey $eventKey | Out-Null}
}
function Barrier($session){if($FixtureMode){return -not(Play-Allowed $session)};foreach($image in $clients){if(-not(Test-Path -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\$image")){return $false}};$true}
function Website-Blocked {if(-not(Test-Path -LiteralPath $HostsPath)){return $false};$text=[IO.File]::ReadAllText($HostsPath);foreach($d in $domains){if($text-notmatch "(?m)^\s*(?:0\.0\.0\.0|127\.0\.0\.1)\s+$([regex]::Escape($d))\s*$"){return $false}};$true}
function Valid-Installer($file){if($file.Name-notmatch $installerPattern){return $false};if($SkipSignatureValidation){return $true};$sig=Get-AuthenticodeSignature -LiteralPath $file.FullName;$sig.Status-eq'Valid'-and[string]$sig.SignerCertificate.Subject-match'(?i)Tencent'}
function Signer($path){if($SkipSignatureValidation){return 'Fixture Tencent'};[string](Get-AuthenticodeSignature -LiteralPath $path).SignerCertificate.Subject}
function Prop($object,[string]$name){$property=$object.PSObject.Properties[$name];if($property){return $property.Value};$null}
function Vault {
 $v=Db 'vault-active';if(-not $v-or-not(Test-Path -LiteralPath ([string]$v.vaultPath)-PathType Leaf)){return $null}
 if((Get-FileHash -LiteralPath ([string]$v.vaultPath)-Algorithm SHA256).Hash-ne[string]$v.sha256){return $null}
 if([string]$v.originalName-notmatch $installerPattern){return $null}
 if(-not $SkipSignatureValidation){$sig=Get-AuthenticodeSignature -LiteralPath ([string]$v.vaultPath);if($sig.Status-ne'Valid'-or[string]$sig.SignerCertificate.Subject-notmatch'(?i)Tencent'){return $null}};$v
}
function Uninstall-Entries {
 if($FixtureMode){ return @() }
 $roots=@('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
 @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object {
  ($_.PSObject.Properties.Name -contains 'DisplayName') -and ($_.PSObject.Properties.Name -contains 'Publisher') -and
  [string]$_.DisplayName -match '(?i)(^|\s)(Tencent\s+)?QQ(\s|$)' -and [string]$_.Publisher -match '(?i)(Tencent|腾讯)'
 })
}
function Install-Root($entry) {
 $root=[string](Prop $entry 'InstallLocation')
 if(-not $root){$line=[string](Prop $entry 'UninstallString');if($line -match '^\s*"([^"]+)"'){$root=Split-Path -Parent $Matches[1]}elseif($line -match '^\s*(\S+)'){$root=Split-Path -Parent $Matches[1]}}
 $root
}
function Assert-QQExecutable($path) {
 if([IO.Path]::GetFileName($path) -ine 'QQ.exe'){throw 'Expected the exact QQ.exe launch file.'}
 $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'QQ.exe must be an ordinary file.'}
 if(-not $SkipSignatureValidation){$sig=Get-AuthenticodeSignature -LiteralPath $item.FullName;if($sig.Status -ne 'Valid' -or [string]$sig.SignerCertificate.Subject -notmatch '(?i)Tencent'){throw 'QQ.exe does not have a valid Tencent signature.'}}
 $item
}
function Discover-QQExecutable {
 if($FixtureMode){$path=Join-Path $FixtureInstallPath 'QQ.exe';if(Test-Path -LiteralPath $path -PathType Leaf){return (Assert-QQExecutable $path).FullName};return $null}
 foreach($entry in Uninstall-Entries){$root=Install-Root $entry;if(-not $root -or -not(Test-Path -LiteralPath $root)){continue};$candidate=Join-Path $root 'QQ.exe';if(Test-Path -LiteralPath $candidate -PathType Leaf){return (Assert-QQExecutable $candidate).FullName}}
 return $null
}
function Exe-Paths {$path=Discover-QQExecutable;if($path){@($path)}else{@()}}
function Installed {@(Exe-Paths).Count -gt 0}
function Executable-Vault {Db 'installed-vault-active-internal'}
function Assert-SystemWorker {if($FixtureMode){return};if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18'){throw 'This QQ vault operation requires the SYSTEM account.'}}
function Resolve-ExecutableContainerRoot {
 if($ExecutableContainerRoot){return [IO.Path]::GetFullPath($ExecutableContainerRoot)}
 if(-not$ContainerConfigPath-or-not(Test-Path -LiteralPath $ContainerConfigPath -PathType Leaf)){throw 'QQ encrypted container configuration is missing.'}
 $config=Get-Content -LiteralPath $ContainerConfigPath -Raw -Encoding UTF8|ConvertFrom-Json
 if(-not$config.Root){throw 'QQ encrypted container root is missing from configuration.'}
 [IO.Path]::GetFullPath([string]$config.Root)
}
function New-OpaqueContainerPath {
 $root=Resolve-ExecutableContainerRoot
 New-Item -ItemType Directory -Path $root -Force|Out-Null
 $name=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()+'.dat'
 Join-Path $root $name
}
function Test-PlainExecutableRecord($path,$record) {
 if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return $false}
 try{
  $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){return $false}
  if(-not $SkipSignatureValidation){$sig=Get-AuthenticodeSignature -LiteralPath $item.FullName;if($sig.Status -ne 'Valid' -or [string]$sig.SignerCertificate.Subject -notmatch '(?i)Tencent'){return $false}}
  (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq [string]$record.sha256
 }catch{$false}
}
function Test-EncryptedExecutableRecord($record) {
 $script:lastContainerValidationError=$null
 $path=[string]$record.vaultPath;if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return $false}
 New-Item -ItemType Directory -Path $stageRoot -Force|Out-Null
 $temporary=Join-Path $stageRoot ('verify-'+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(12)).ToLowerInvariant()+'.tmp')
 try{
  [void](Expand-QQEncryptedContainer -ContainerPath $path -DestinationPath $temporary -KeyUnprotector $script:containerKeyUnprotector)
  Test-PlainExecutableRecord $temporary $record
 }catch{$script:lastContainerValidationError=$_.Exception.Message;$false}finally{Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue}
}
function Valid-ProtectedExecutable($record) {
 if(-not $record -or [string]$record.state -notin @('protected','protecting','restoring')){return $false}
 $path=[string]$record.vaultPath;if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return $false}
 if([int]$record.formatVersion-eq2){return (Test-EncryptedExecutableRecord $record)}
 if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne [string]$record.sha256){return $false}
 if(-not $SkipSignatureValidation){$sig=Get-AuthenticodeSignature -LiteralPath $path;if($sig.Status -ne 'Valid' -or [string]$sig.SignerCertificate.Subject -notmatch '(?i)Tencent'){return $false}}
 $true
}
function Save-ExecutableVault($record){Db 'installed-vault-upsert64' $record}
function Update-ExecutableVault($record){Db 'installed-vault-update64' $record}
function QQ-Processes($path,[Nullable[int]]$sessionId=$null) {
 $exact=[IO.Path]::GetFullPath([string]$path).ToLowerInvariant();@(
  Get-Process -Name 'QQ' -ErrorAction SilentlyContinue|Where-Object{
   try{[IO.Path]::GetFullPath($_.Path).ToLowerInvariant()-eq$exact-and($null-eq$sessionId-or$_.SessionId-eq$sessionId)}catch{$false}
  }
 )
}
function Launch-Interactive($s) {
 if(-not $s-or[string]$s.phase-ne'playing'-or-not(Play-Allowed $s)){throw 'QQ session is not authorized for interactive launch.'}
 $path=Discover-QQExecutable;if(-not $path){throw 'Installed Tencent QQ.exe was not found.'}
 if($FixtureMode){return [ordered]@{ok=$true;sessionId=[string]$s.id;path=[string]$path;processId=1;desktopSessionId=1;startedAt=$clock.ToString('o')}}
 $desktopSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
 [void](Start-Process -FilePath ([string]$path) -PassThru)
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds(8);$match=$null
 do{$match=@(QQ-Processes $path $desktopSessionId)|Select-Object -First 1;if($match){break};Start-Sleep -Milliseconds 100}while([DateTimeOffset]::UtcNow-lt$deadline)
 if(-not $match){throw 'QQ did not start in the interactive desktop session.'}
 [ordered]@{ok=$true;sessionId=[string]$s.id;path=[string]$path;processId=$match.Id;desktopSessionId=$desktopSessionId;startedAt=[DateTimeOffset]::UtcNow.ToString('o')}
}
function Request-InteractiveLaunch($s,$path) {
 if($FixtureMode){return Launch-Interactive $s}
 Remove-Item -LiteralPath $launchStatusPath -Force -ErrorAction SilentlyContinue
 Start-ScheduledTask -TaskName $launchTaskName -ErrorAction Stop
 $deadline=[DateTimeOffset]::UtcNow.AddSeconds(12)
 do{
  if(Test-Path -LiteralPath $launchStatusPath){
   try{$launch=Get-Content -Raw -LiteralPath $launchStatusPath -Encoding UTF8|ConvertFrom-Json -DateKind String}catch{$launch=$null}
   if($launch-and[string]$launch.sessionId-eq[string]$s.id){
    if(-not $launch.ok){throw ([string]$launch.error)}
    if(@(QQ-Processes $path ([int]$launch.desktopSessionId)).Count-gt 0){return $launch}
   }
  }
  Start-Sleep -Milliseconds 100
 }while([DateTimeOffset]::UtcNow-lt$deadline)
 throw 'QQ interactive launch did not complete in time.'
}
function Stop-QQ($path) {
 $exact=[IO.Path]::GetFullPath($path).ToLowerInvariant();$matches=@()
 foreach($process in Get-Process -ErrorAction SilentlyContinue){try{if([IO.Path]::GetFullPath($process.Path).ToLowerInvariant() -eq $exact){$matches+=$process;[void]$process.CloseMainWindow()}}catch{}}
 if($matches.Count){Start-Sleep -Seconds 3}
 foreach($process in $matches){try{$process.Refresh();if(-not $process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction Stop}}catch{}}
}
function Migrate-LegacyExecutableVault {
 Assert-SystemWorker
 $record=Executable-Vault
 if(-not$record-or[int]$record.formatVersion-eq2-or[string]$record.state-ne'protected'){return}
 $legacy=[string]$record.vaultPath
 if(-not(Test-PlainExecutableRecord $legacy $record)){Update-ExecutableVault @{state='invalid';error='Legacy protected QQ.exe verification failed.';updatedAt=$clock.ToString('o')};throw 'Legacy protected QQ.exe verification failed.'}
 $container=New-OpaqueContainerPath
 try{
  [void](Write-QQEncryptedContainer -SourcePath $legacy -ContainerPath $container -KeyProtector $script:containerKeyProtector)
  $candidate=[pscustomobject]@{vaultPath=$container;formatVersion=2;sha256=[string]$record.sha256;state='protected'}
  if(-not(Test-EncryptedExecutableRecord $candidate)){throw 'Encrypted QQ.exe migration verification failed.'}
  [void](Update-ExecutableVault @{vaultPath=$container;formatVersion=2;state='protected';error=$null;updatedAt=$clock.ToString('o')})
  Remove-Item -LiteralPath $legacy -Force
 }catch{Remove-Item -LiteralPath $container -Force -ErrorAction SilentlyContinue;throw}
}
function Protect-QQExecutable {
 Assert-SystemWorker
 $path=Discover-QQExecutable;if(-not $path){throw 'Installed Tencent QQ.exe was not found.'}
 Stop-QQ $path;[void](Assert-QQExecutable $path)
 $dest=New-OpaqueContainerPath;$hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
 try{
  [void](Write-QQEncryptedContainer -SourcePath $path -ContainerPath $dest -KeyProtector $script:containerKeyProtector)
  $candidate=[pscustomobject]@{vaultPath=$dest;formatVersion=2;sha256=$hash;state='protecting'}
  if(-not(Test-EncryptedExecutableRecord $candidate)){throw "Encrypted QQ.exe verification failed: $script:lastContainerValidationError"}
 }catch{Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue;throw}
 [void](Save-ExecutableVault @{originalPath=$path;vaultPath=$dest;formatVersion=2;sha256=$hash;signer=(Signer $path);state='protecting';protectedAt=$clock.ToString('o');updatedAt=$clock.ToString('o')})
 Remove-Item -LiteralPath $path -Force
 Update-ExecutableVault @{state='protected';protectedAt=$clock.ToString('o');error=$null;updatedAt=$clock.ToString('o')}
}
function Restore-QQExecutable {
 $record=Executable-Vault
 if(-not $record){$path=Discover-QQExecutable;if(-not $path){throw 'Installed Tencent QQ.exe was not found.'};return $path}
 if([string]$record.state -eq 'available'){$path=Discover-QQExecutable;if(-not $path){throw 'Installed Tencent QQ.exe was not found.'};return $path}
 $dest=[string]$record.originalPath
 if(Test-Path -LiteralPath $dest){
  try{
   [void](Assert-QQExecutable $dest)
   if((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -eq [string]$record.sha256){
    [void](Update-ExecutableVault @{state='available';vaultPath=$null;restoredAt=$clock.ToString('o');error=$null;updatedAt=$clock.ToString('o')})
    if($record.vaultPath){Remove-Item -LiteralPath ([string]$record.vaultPath) -Force -ErrorAction SilentlyContinue}
    return $dest
   }
  }catch{}
  Update-ExecutableVault @{state='conflict';error='QQ.exe original path is occupied by a different file.';updatedAt=$clock.ToString('o')};throw 'QQ.exe restoration conflict: original path is occupied by a different file.'
 }
 if(-not(Valid-ProtectedExecutable $record)){Update-ExecutableVault @{state='invalid';error='Protected QQ.exe verification failed.';updatedAt=$clock.ToString('o')};throw 'Protected QQ.exe is missing or failed verification.'}
 if([int]$record.formatVersion-eq2){Assert-SystemWorker}
 [void](Update-ExecutableVault @{state='restoring';updatedAt=$clock.ToString('o')});New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
 if([int]$record.formatVersion-eq2){
  $temporary=Join-Path (Split-Path -Parent $dest) ('.qq-restore-'+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(12)).ToLowerInvariant()+'.tmp')
  try{
   [void](Expand-QQEncryptedContainer -ContainerPath ([string]$record.vaultPath) -DestinationPath $temporary -KeyUnprotector $script:containerKeyUnprotector)
   if(-not(Test-PlainExecutableRecord $temporary $record)){throw 'Restored QQ.exe verification failed.'}
   [IO.File]::Move($temporary,$dest,$false)
  }finally{Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue}
 }else{Move-Item -LiteralPath ([string]$record.vaultPath) -Destination $dest}
 [void](Assert-QQExecutable $dest)
 [void](Update-ExecutableVault @{state='available';vaultPath=$null;restoredAt=$clock.ToString('o');error=$null;updatedAt=$clock.ToString('o')})
 if([int]$record.formatVersion-eq2){Remove-Item -LiteralPath ([string]$record.vaultPath) -Force -ErrorAction SilentlyContinue}
 $dest
}
function Installer-Roots {
 if($FixtureMode){return @($FixtureDownloadsPath)}
 $configPath=Join-Path $StateRoot 'config.json';if(-not(Test-Path -LiteralPath $configPath)){return @()};$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
 @([string]$config.DesktopPath,[string]$config.DownloadsPath)|Where-Object{$_ -and(Test-Path -LiteralPath $_)}|Select-Object -Unique
}
function Remove-QQInstallers {
 foreach($root in Installer-Roots){foreach($file in @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue)){
  if($file.Name -notmatch $installerPattern){continue};if(-not(Valid-Installer $file)){[void](Db 'event64' @{sessionId=$null;occurredAt=$clock.ToString('o');event=@{action='qq_installer_skipped';result='ignored';detail=@{path=$file.FullName}}});continue}
  Remove-Item -LiteralPath $file.FullName -Force;[void](Db 'event64' @{sessionId=$null;occurredAt=$clock.ToString('o');event=@{action='qq_installer_deleted';result='ok';detail=@{path=$file.FullName}}})
 }}
}
function Delete-QQInstaller($path) {
 $file=Get-Item -LiteralPath $path -Force -ErrorAction Stop
 if(-not(Valid-Installer $file)){throw 'File is not a valid Tencent QQ installer.'}
 Remove-Item -LiteralPath $file.FullName -Force
 [void](Db 'event64' @{sessionId=$null;occurredAt=$clock.ToString('o');event=@{action='qq_installer_deleted';result='ok';detail=@{path=$file.FullName}}})
}
function Recover-ExecutableVault {
 $record=Executable-Vault;if(-not $record){return}
 $source=[string]$record.originalPath;$vault=[string]$record.vaultPath
 if([string]$record.state -in @('invalid','conflict') -and (Test-Path -LiteralPath $source -PathType Leaf)){
  try{
   [void](Assert-QQExecutable $source)
   if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -eq [string]$record.sha256){[void](Update-ExecutableVault @{state='available';vaultPath=$null;restoredAt=$clock.ToString('o');error=$null;updatedAt=$clock.ToString('o')});if($vault){Remove-Item -LiteralPath $vault -Force -ErrorAction SilentlyContinue};return}
  }catch{}
 }
 if([string]$record.state -eq 'protecting'){
  $sourceValid=Test-PlainExecutableRecord $source $record;$vaultValid=Valid-ProtectedExecutable $record
  if($vaultValid){if($sourceValid){Remove-Item -LiteralPath $source -Force};Update-ExecutableVault @{state='protected';error=$null;updatedAt=$clock.ToString('o')};return}
  if($sourceValid){Update-ExecutableVault @{state='available';vaultPath=$null;error=$null;updatedAt=$clock.ToString('o')};return}
  Update-ExecutableVault @{state='invalid';error='Neither protecting copy is valid.';updatedAt=$clock.ToString('o')};return
 }
 if([string]$record.state -eq 'restoring'){
  if(Test-PlainExecutableRecord $source $record){Update-ExecutableVault @{state='available';vaultPath=$null;restoredAt=$clock.ToString('o');error=$null;updatedAt=$clock.ToString('o')};if($vault){Remove-Item -LiteralPath $vault -Force -ErrorAction SilentlyContinue};return}
  if(Valid-ProtectedExecutable $record){Update-ExecutableVault @{state='protected';error=$null;updatedAt=$clock.ToString('o')};return}
  Update-ExecutableVault @{state='invalid';error='QQ.exe restoration recovery found no valid copy.';updatedAt=$clock.ToString('o')}
 }
}
function Phase($s){if(-not $s){return 'ready'};if([string]$s.phase -eq 'preparing' -or -not $s.playEndsAt){return [string]$s.phase};if($clock -lt [DateTimeOffset]::Parse([string]$s.playEndsAt).ToUniversalTime()){return 'playing'};if($clock -lt [DateTimeOffset]::Parse([string]$s.cooldownEndsAt).ToUniversalTime()){return 'cooldown'};'ready'}
function Public-ExecutableVault($record){if(-not $record){return $null};[ordered]@{state=[string]$record.state;formatVersion=[int]$record.formatVersion;sha256=[string]$record.sha256;signer=[string]$record.signer;protectedAt=$record.protectedAt;restoredAt=$record.restoredAt;updatedAt=$record.updatedAt;error=$record.error}}
function Status($s){$record=Executable-Vault;$path=Discover-QQExecutable;$allowed=Play-Allowed $s;$interactive=if($FixtureMode){$allowed-and[bool]$path}else{$false};if(-not$FixtureMode-and$allowed-and$path){$launch=if(Test-Path -LiteralPath $launchStatusPath){try{Get-Content -Raw -LiteralPath $launchStatusPath|ConvertFrom-Json -DateKind String}catch{$null}}else{$null};if($launch-and[string]$launch.sessionId-eq[string]$s.id){$interactive=@(QQ-Processes $path ([int]$launch.desktopSessionId)).Count-gt 0}};$vaultReady=([bool]$path -or (Valid-ProtectedExecutable $record));[ordered]@{ok=$true;phase=(Phase $s);sessionId=if($s){[string]$s.id}else{$null};session=$s;authorizationActive=$allowed;clientBarrierActive=(Barrier $s);websiteBlockActive=(Website-Blocked);vaultReady=$vaultReady;installedExecutableVault=(Public-ExecutableVault $record);executableReady=$vaultReady;stagingClear=$true;qqInstalled=([bool]$path);interactiveProcessActive=$interactive;qqExecutablePaths=@($path|Where-Object{$_});currentTime=$clock.ToString('o')}}
function Prepare($s){
 if(-not $s -or [string]$s.phase -ne 'preparing'){throw 'No preparing QQ request exists.'}
 $path=$null
 try{
  [void](Test-QQSessionWindow $s);Remove-QQInstallers
  $restored=@(Restore-QQExecutable);if($restored.Count-ne 1-or$restored[0]-isnot[string]){throw 'QQ executable restoration returned an invalid path.'};$path=[string]$restored[0]
  $s=Db 'activate64' @{id=$s.id;confirmedAt=$clock.ToString('o');tasks=@{reconcileTaskName='MashiroBot-QQSession-Reconcile'}}
  Authorize $s $null ([DateTimeOffset]::Parse([string]$s.playEndsAt));Apply-Focus;if(Barrier $s){throw 'QQ play authorization did not release the client barrier.'}
  [void](Request-InteractiveLaunch $s $path)
  if([string]$s.windowPolicy-eq'sunday-4h'){$s=Db 'consume-sunday64' @{id=$s.id;consumedAt=$clock.ToString('o')}}
  $result=Status $s;if(-not$result.interactiveProcessActive){throw 'QQ desktop process verification failed.'};$result
 }catch{
  $message=$_.Exception.Message;$current=Session
  try{Authorize $current $null $null;Apply-Focus;if($path-and(Test-Path -LiteralPath $path)){[void](Protect-QQExecutable)}}catch{}
  try{if($current-and[string]$current.phase-eq'playing'){[void](Db 'phase64' @{id=$current.id;phase='failed';updatedAt=[DateTimeOffset]::UtcNow.ToString('o');event=@{action='qq_start_rollback';result='failed';error=$message}})}else{[void](Db 'fail64' @{id=$s.id;error=$message;updatedAt=[DateTimeOffset]::UtcNow.ToString('o')})}}catch{}
  throw $message
 }
}
function Resume($s){
 if(-not $s-or[string]$s.phase-ne'cooldown'-or-not$s.playEndsAt-or$clock-ge[DateTimeOffset]::Parse([string]$s.playEndsAt).ToUniversalTime()){throw 'No prematurely closed QQ session is eligible for resume.'}
 $path=$null;$resumed=$false
 try{
  [void](Test-QQSessionWindow $s);$restored=@(Restore-QQExecutable);if($restored.Count-ne 1-or$restored[0]-isnot[string]){throw 'QQ executable restoration returned an invalid path.'};$path=[string]$restored[0]
  $s=Db 'resume64' @{id=$s.id;updatedAt=$clock.ToString('o')};$resumed=$true
  Authorize $s $null ([DateTimeOffset]::Parse([string]$s.playEndsAt));Apply-Focus;if(Barrier $s){throw 'QQ play authorization did not release the client barrier.'}
  [void](Request-InteractiveLaunch $s $path);$result=Status $s;if(-not$result.interactiveProcessActive){throw 'QQ desktop process verification failed.'};$result
 }catch{
  $message=$_.Exception.Message;try{Authorize $s $null $null;Apply-Focus;if($path-and(Test-Path -LiteralPath $path)){[void](Protect-QQExecutable)}}catch{}
  if($resumed){try{[void](Db 'phase64' @{id=$s.id;phase='cooldown';updatedAt=[DateTimeOffset]::UtcNow.ToString('o');event=@{action='premature_close_resume_rollback';result='failed';error=$message}})}catch{}}
  throw $message
 }
}
function Reconcile($s){
 Remove-QQInstallers;Recover-ExecutableVault;Migrate-LegacyExecutableVault
 if(-not $s){
  Authorize $null $null $null;Apply-Focus
  if(Discover-QQExecutable){[void](Protect-QQExecutable)}
  return Status $null
 }
 if([string]$s.phase -eq 'preparing'){return Prepare $s}
 if([string]$s.phase -eq 'uninstall_failed'){
  [void](Db 'phase64' @{id=$s.id;phase='ready';updatedAt=$clock.ToString('o');event=@{action='legacy_uninstall_resolved';result='ok'}})
  return Reconcile (Session)
 }
 $phase=Phase $s
 if($phase -eq 'playing'){
  try{[void](Test-QQSessionWindow $s)}catch{
   Authorize $s $null $null;Apply-Focus;if(-not(Barrier $s)){throw 'Permanent QQ client barrier was not restored at the daily window boundary.'}
   [void](Protect-QQExecutable)
   $s=Db 'phase64' @{id=$s.id;phase='cooldown';updatedAt=$clock.ToString('o');event=@{action='qq_daily_window_closed';result='ok';uninstallResult='not_used'}}
   return Status $s
  }
  Authorize $s $null ([DateTimeOffset]::Parse([string]$s.playEndsAt));Apply-Focus;return Status $s
 }
 Authorize $s $null $null;Apply-Focus
 if(-not(Barrier $s)){throw 'Permanent QQ client barrier was not restored.'}
 if([string]$s.phase -eq 'playing'){
  try{
   [void](Protect-QQExecutable)
   $s=Db 'phase64' @{id=$s.id;phase='cooldown';updatedAt=$clock.ToString('o');event=@{action='qq_executable_protected';result='ok';uninstallResult='not_used'}}
  }catch{
   [void](Db 'event64' @{sessionId=$s.id;occurredAt=$clock.ToString('o');event=@{action='qq_executable_protection';result='failed';error=$_.Exception.Message}})
   throw
  }
 }
 if($phase -eq 'cooldown') { Submit-TimeoutReading $s }
 if($phase -eq 'ready' -and [string]$s.phase -ne 'ready'){$s=Db 'phase64' @{id=$s.id;phase='ready';updatedAt=$clock.ToString('o');event=@{action='cooldown_completed';result='ok'}}}
 Status $s
}
function Watch {while($true){Refresh-Clock;$s=Session;$status=Reconcile $s;Save-Atomic $statusPath $status;if(-not $s -or [string]$status.phase -eq 'ready'){return $status};$fresh=Session;$deadline=if([string]$status.phase -eq 'playing'){[DateTimeOffset]::Parse([string]$fresh.playEndsAt)}else{[DateTimeOffset]::Parse([string]$fresh.cooldownEndsAt)};$seconds=[Math]::Ceiling(($deadline.ToUniversalTime()-[DateTimeOffset]::UtcNow).TotalSeconds);if($seconds -gt 0){Start-Sleep -Seconds ([Math]::Min(60,[Math]::Max(1,[int]$seconds)))}}}
function Manual-Restore {
 Assert-SystemWorker;if(-not(Manual-Allowed)){throw 'Manual QQ release authorization is missing or expired.'}
 [void](Restore-QQExecutable);Apply-Focus;$result=Status $null;$result['manualAuthorizationActive']=$true;$result
}
function Manual-Protect {
 Assert-SystemWorker;if(Manual-Allowed){throw 'Manual QQ release authorization is still active.'}
 Authorize $null $null $null;Apply-Focus;if(Discover-QQExecutable){[void](Protect-QQExecutable)};$result=Status $null;$result['manualAuthorizationActive']=$false;$result
}
function Maintenance-Restore {Assert-SystemWorker;[void](Restore-QQExecutable);Status $null}
$session=Session
try{$result=switch($Mode){'Capture'{if(-not $InstallerPath){throw 'Capture requires -InstallerPath.'};Delete-QQInstaller $InstallerPath;[ordered]@{ok=$true;deleted=$true}}'PrepareAndStart'{Prepare $session}'LaunchInteractive'{Launch-Interactive $session}'Reconcile'{Reconcile $session}'Watch'{Watch}'Resume'{Resume $session}'Recover'{Remove-QQInstallers;Recover-ExecutableVault;Authorize $session $null $null;Apply-Focus;Status $session}'ManualRestore'{Manual-Restore}'ManualProtect'{Manual-Protect}'MaintenanceRestore'{Maintenance-Restore}'Status'{Status $session}};if($Mode-eq'LaunchInteractive'){Save-Atomic $launchStatusPath $result}elseif($Mode-notin@('Status','Capture')){Save-Atomic $statusPath $result};[pscustomobject]$result|ConvertTo-Json -Depth 12 -Compress}catch{$message=$_.Exception.Message;try{[void](Db 'event64' @{sessionId=if($session){$session.id}else{$null};occurredAt=[DateTimeOffset]::UtcNow.ToString('o');event=@{action="worker_$($Mode.ToLowerInvariant())";result='failed';error=$message}})}catch{};if($Mode-eq'LaunchInteractive'){Save-Atomic $launchStatusPath ([ordered]@{ok=$false;sessionId=if($session){[string]$session.id}else{$null};error=$message;failedAt=[DateTimeOffset]::UtcNow.ToString('o')})}elseif($Mode-in@('PrepareAndStart','Watch','Resume','ManualRestore','ManualProtect','MaintenanceRestore')){Save-Atomic $statusPath ([ordered]@{ok=$false;phase='failed';sessionId=if($session){[string]$session.id}else{$null};error=$message;currentTime=[DateTimeOffset]::UtcNow.ToString('o')})};throw}
