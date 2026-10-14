[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$root=Join-Path $env:TEMP ('qq-container-test-'+[guid]::NewGuid().ToString('N'))
$helper=Join-Path (Split-Path -Parent $PSScriptRoot) 'powershell\qq-executable-container-v2.ps1'
. $helper
$passThroughProtect={param([byte[]]$key) [byte[]]$key.Clone()}
$passThroughUnprotect={param([byte[]]$wrapped) [byte[]]$wrapped.Clone()}
try{
 New-Item -ItemType Directory -Path $root -Force|Out-Null
 $source=Join-Path $root 'source.exe';$container=Join-Path $root 'cache.dat';$restored=Join-Path $root 'restored.exe'
 Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $source
 $expected=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
 [void](Write-QQEncryptedContainer -SourcePath $source -ContainerPath $container -KeyProtector $passThroughProtect)
 $head=[IO.File]::ReadAllBytes($container)[0..1]
 if([Convert]::ToHexString($head)-eq'MZ'){throw 'Encrypted container retained a PE header.'}
 if(-not(Test-QQEncryptedContainer -ContainerPath $container -ExpectedSha256 $expected -KeyUnprotector $passThroughUnprotect)){throw 'Encrypted container validation failed.'}
 [void](Expand-QQEncryptedContainer -ContainerPath $container -DestinationPath $restored -KeyUnprotector $passThroughUnprotect)
 if((Get-FileHash -LiteralPath $restored -Algorithm SHA256).Hash-ne$expected){throw 'Encrypted container round trip hash mismatch.'}

 $wrongKey={param([byte[]]$wrapped) [byte[]]::new(32)}
 $wrongRejected=$false;try{[void](Expand-QQEncryptedContainer -ContainerPath $container -DestinationPath (Join-Path $root 'wrong.exe') -KeyUnprotector $wrongKey)}catch{$wrongRejected=$true}
 if(-not$wrongRejected){throw 'Encrypted container accepted the wrong key.'}

 $tampered=Join-Path $root 'tampered.dat';Copy-Item -LiteralPath $container -Destination $tampered
 $bytes=[IO.File]::ReadAllBytes($tampered);$bytes[$bytes.Length-1]=$bytes[$bytes.Length-1]-bxor 1;[IO.File]::WriteAllBytes($tampered,$bytes)
 if(Test-QQEncryptedContainer -ContainerPath $tampered -ExpectedSha256 $expected -KeyUnprotector $passThroughUnprotect){throw 'Encrypted container accepted tampered ciphertext.'}

 $truncated=Join-Path $root 'truncated.dat';[IO.File]::WriteAllBytes($truncated,[byte[]](1,2,3,4))
 if(Test-QQEncryptedContainer -ContainerPath $truncated -ExpectedSha256 $expected -KeyUnprotector $passThroughUnprotect){throw 'Encrypted container accepted truncated data.'}
 [ordered]@{ok=$true;roundTripHash=$expected;containerStartsWithMZ=$false;wrongKeyRejected=$true;tamperRejected=$true;truncatedRejected=$true}|ConvertTo-Json -Compress
}finally{if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force}}
