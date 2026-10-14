[CmdletBinding()]
param(
 [string]$Destination=(Join-Path $env:LOCALAPPDATA 'MashiroBot\runtime\python312'),
 [string]$BasePython,[string]$UvPath,[string]$PillowVersion='12.1.1'
)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$OutputEncoding
function Test-Runtime([string]$Python){if(-not(Test-Path -LiteralPath $Python -PathType Leaf)){return $false};$out=@(& $Python -c 'import sys,sqlite3;from PIL import Image;assert sys.version_info[:2] in ((3,11),(3,12),(3,13));print(Image.__version__)' 2>&1);return($LASTEXITCODE-eq 0-and($out-join'').Trim())}
$Destination=[IO.Path]::GetFullPath($Destination);$RuntimePython=Join-Path $Destination 'Scripts\python.exe'
if(Test-Runtime $RuntimePython){[ordered]@{ok=$true;reused=$true;pythonPath=$RuntimePython;destination=$Destination}|ConvertTo-Json -Compress;exit 0}
if(-not$UvPath){$UvPath=(Get-Command uv.exe -ErrorAction SilentlyContinue|Select-Object -First 1).Source};if(-not$UvPath){throw 'uv.exe was not found; install uv or provide -UvPath.'}
if(-not$BasePython){$found=@(& $UvPath python find 3.12 2>&1);if($LASTEXITCODE-ne 0){throw "uv could not find Python 3.12: $($found-join[Environment]::NewLine)"};$BasePython=($found|Select-Object -Last 1).Trim()}
if(-not(Test-Path -LiteralPath $BasePython -PathType Leaf)){throw "Base Python does not exist: $BasePython"}
$versionText=@(& $BasePython -c 'import sys;print(".".join(map(str,sys.version_info[:3])))' 2>&1);if($LASTEXITCODE-ne 0){throw "Base Python failed: $($versionText-join' ')"};$version=[version](($versionText-join'').Trim());if($version.Major-ne 3-or$version.Minor-lt 11-or$version.Minor-gt 13){throw "Base Python $version is outside 3.11-3.13."}
$parent=Split-Path -Parent $Destination;New-Item -ItemType Directory -Path $parent -Force|Out-Null;$staging=Join-Path $parent ('python-staging-'+[guid]::NewGuid().ToString('N'));$archive=$null
try{
 $created=@(& $UvPath venv --python $BasePython $staging 2>&1);if($LASTEXITCODE-ne 0){throw "uv venv failed: $($created-join[Environment]::NewLine)"};$stagingPython=Join-Path $staging 'Scripts\python.exe'
 $installed=@(& $UvPath pip install --python $stagingPython "Pillow==$PillowVersion" 2>&1);if($LASTEXITCODE-ne 0){throw "Pillow installation failed: $($installed-join[Environment]::NewLine)"};if(-not(Test-Runtime $stagingPython)){throw 'Provisioned Python failed sqlite3/Pillow validation.'}
 if(Test-Path -LiteralPath $Destination){$archive="$Destination.previous-$(Get-Date -Format 'yyyyMMdd-HHmmss')";Move-Item -LiteralPath $Destination -Destination $archive}
 Move-Item -LiteralPath $staging -Destination $Destination
 [ordered]@{ok=$true;reused=$false;pythonPath=$RuntimePython;destination=$Destination;archived=$archive;version=$version.ToString();pillowVersion=$PillowVersion}|ConvertTo-Json -Compress
}catch{if($archive-and-not(Test-Path -LiteralPath $Destination)-and(Test-Path -LiteralPath $archive)){Move-Item -LiteralPath $archive -Destination $Destination};throw}finally{Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue}
