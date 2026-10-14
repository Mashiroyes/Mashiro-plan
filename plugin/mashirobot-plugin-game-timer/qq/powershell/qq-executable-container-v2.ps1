$script:QQContainerMagic = [Text.Encoding]::ASCII.GetBytes('MQVLT002')
$script:QQContainerEntropy = [Text.Encoding]::UTF8.GetBytes('MashiroBot.QQ.Container.v2')

function Assert-QQSystemIdentity {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($sid -ne 'S-1-5-18') { throw 'QQ executable container key operations require the SYSTEM account.' }
}

function Protect-QQContainerKeyForSystem {
    param([Parameter(Mandatory)][byte[]]$Key)
    Assert-QQSystemIdentity
    [Security.Cryptography.ProtectedData]::Protect(
        $Key,
        $script:QQContainerEntropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Unprotect-QQContainerKeyForSystem {
    param([Parameter(Mandatory)][byte[]]$WrappedKey)
    Assert-QQSystemIdentity
    [Security.Cryptography.ProtectedData]::Unprotect(
        $WrappedKey,
        $script:QQContainerEntropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Read-QQContainerParts {
    param([Parameter(Mandatory)][string]$ContainerPath)
    $stream = [IO.File]::Open($ContainerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 73) { throw 'QQ encrypted container is truncated.' }
        $reader = [IO.BinaryReader]::new($stream, [Text.Encoding]::UTF8, $true)
        try {
            $magic = $reader.ReadBytes(8)
            if ($magic.Length -ne 8 -or -not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($magic, $script:QQContainerMagic)) {
                throw 'QQ encrypted container magic is invalid.'
            }
            $wrappedLength = $reader.ReadInt32()
            if ($wrappedLength -lt 32 -or $wrappedLength -gt 16384) { throw 'QQ encrypted container key length is invalid.' }
            $nonce = $reader.ReadBytes(12)
            $tag = $reader.ReadBytes(16)
            $wrappedKey = $reader.ReadBytes($wrappedLength)
            $cipherLength = $stream.Length - $stream.Position
            if ($nonce.Length -ne 12 -or $tag.Length -ne 16 -or $wrappedKey.Length -ne $wrappedLength -or $cipherLength -lt 1 -or $cipherLength -gt [int]::MaxValue) {
                throw 'QQ encrypted container structure is invalid.'
            }
            $ciphertext = $reader.ReadBytes([int]$cipherLength)
            if ($ciphertext.Length -ne [int]$cipherLength) { throw 'QQ encrypted container payload is truncated.' }
            [pscustomobject]@{ Nonce=$nonce; Tag=$tag; WrappedKey=$wrappedKey; Ciphertext=$ciphertext }
        } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Write-QQEncryptedContainer {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourcePath,
        [Parameter(Mandatory)][string]$ContainerPath,
        [scriptblock]$KeyProtector
    )
    $source = [IO.Path]::GetFullPath($SourcePath)
    $destination = [IO.Path]::GetFullPath($ContainerPath)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "QQ executable source does not exist: $source" }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    $temporary = "$destination.$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(12)).ToLowerInvariant()).tmp"
    [byte[]]$key = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    [byte[]]$nonce = [Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
    [byte[]]$plaintext = [IO.File]::ReadAllBytes($source)
    [byte[]]$ciphertext = [byte[]]::new($plaintext.Length)
    [byte[]]$tag = [byte[]]::new(16)
    try {
        $aes = [Security.Cryptography.AesGcm]::new($key, 16)
        try { $aes.Encrypt($nonce, $plaintext, $ciphertext, $tag, $script:QQContainerMagic) }
        finally { $aes.Dispose() }
        [byte[]]$wrappedKey = if ($KeyProtector) { & $KeyProtector $key } else { Protect-QQContainerKeyForSystem -Key $key }
        if (-not $wrappedKey -or $wrappedKey.Length -lt 32 -or $wrappedKey.Length -gt 16384) { throw 'QQ encrypted container key wrapper returned an invalid result.' }
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        try {
            $writer = [IO.BinaryWriter]::new($stream, [Text.Encoding]::UTF8, $true)
            try {
                $writer.Write($script:QQContainerMagic)
                $writer.Write([int]$wrappedKey.Length)
                $writer.Write($nonce)
                $writer.Write($tag)
                $writer.Write($wrappedKey)
                $writer.Write($ciphertext)
                $writer.Flush()
                $stream.Flush($true)
            } finally { $writer.Dispose() }
        } finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $destination, $true)
        Get-Item -LiteralPath $destination -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($key)
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($plaintext)
    }
}

function Expand-QQEncryptedContainer {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ContainerPath,
        [Parameter(Mandatory)][string]$DestinationPath,
        [scriptblock]$KeyUnprotector
    )
    $destination = [IO.Path]::GetFullPath($DestinationPath)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    $parts = Read-QQContainerParts -ContainerPath $ContainerPath
    [byte[]]$key = if ($KeyUnprotector) { & $KeyUnprotector $parts.WrappedKey } else { Unprotect-QQContainerKeyForSystem -WrappedKey $parts.WrappedKey }
    if (-not $key -or $key.Length -ne 32) { throw 'QQ encrypted container key is invalid.' }
    [byte[]]$plaintext = [byte[]]::new($parts.Ciphertext.Length)
    $temporary = "$destination.$([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(12)).ToLowerInvariant()).tmp"
    try {
        $aes = [Security.Cryptography.AesGcm]::new($key, 16)
        try { $aes.Decrypt($parts.Nonce, $parts.Ciphertext, $parts.Tag, $plaintext, $script:QQContainerMagic) }
        finally { $aes.Dispose() }
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
        try { $stream.Write($plaintext); $stream.Flush($true) } finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $destination, $true)
        Get-Item -LiteralPath $destination -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($key)
        [Security.Cryptography.CryptographicOperations]::ZeroMemory($plaintext)
    }
}

function Test-QQEncryptedContainer {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ContainerPath,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [scriptblock]$KeyUnprotector
    )
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("qq-container-check-{0}.tmp" -f [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(12)).ToLowerInvariant())
    try {
        [void](Expand-QQEncryptedContainer -ContainerPath $ContainerPath -DestinationPath $temporary -KeyUnprotector $KeyUnprotector)
        (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -eq $ExpectedSha256
    } catch { $false }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
