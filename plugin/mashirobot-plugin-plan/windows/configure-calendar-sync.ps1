[CmdletBinding()]
param([ValidateSet('Configure','Inspect')][string]$Action='Configure')
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$OutputEncoding
. (Join-Path $PSScriptRoot 'calendar-credential.ps1')

if ($Action -eq 'Inspect') {
    [pscustomobject]@{ok=$true;account='2768442763@qq.com';credentialPresent=($null -ne (Get-PlanCalendarCredential));target=$script:CalendarCredentialTarget} | ConvertTo-Json -Compress
    exit 0
}
$secret = Read-Host '请输入 QQ 邮箱为 CalDAV 生成的授权码（输入不会显示）' -AsSecureString
if ($secret.Length -lt 8) { throw '授权码为空或长度异常。' }
Set-PlanCalendarCredential -SecureSecret $secret
[pscustomobject]@{ok=$true;account='2768442763@qq.com';credentialStored=$true;target=$script:CalendarCredentialTarget} | ConvertTo-Json -Compress
