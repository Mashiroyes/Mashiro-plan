$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\focus-lock\FocusLock.ps1') -Raw

if ($source -notmatch 'function Merge-PolicyEntries') {
    throw 'FocusLock must define policy-entry compaction.'
}
if ($source -match '\$state\.PolicyEntries\s*=\s*@\(\$state\.PolicyEntries\)\s*\+\s*\$newPolicyEntries') {
    throw 'Reapply must not append browser-policy history without deduplication.'
}
if ($source -notmatch 'Merge-PolicyEntries\s+@\(\$state\.PolicyEntries\)\s+\$newPolicyEntries') {
    throw 'Reapply must compact existing and newly added browser-policy entries.'
}

'focus-lock state compaction contract passed'
