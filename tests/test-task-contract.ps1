$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Module = Join-Path (Split-Path -Parent $PSScriptRoot) 'core\deployment\task-contract.ps1'
. $Module

function Assert-True([bool]$Value,[string]$Message) { if (-not $Value) { throw "ASSERTION FAILED: $Message" } }

$Runtime = [pscustomobject]@{ pwshPath='C:\Program Files\PowerShell\7\pwsh.exe' }
$Worker = 'C:\程序 Files\MashiroBot\qq worker.ps1'
$Action = New-MashiroTaskAction -Runtime $Runtime -WorkerPath $Worker -Arguments @('-Mode','LaunchInteractive','-NodePath','C:\Program Files\nodejs\node.exe','-RuntimeDescriptorPath','C:\用户\config\runtime.json')
Assert-True ($Action.Execute -eq $Runtime.pwshPath) 'task action must use explicit PowerShell path'
Assert-True ($Action.Arguments.Contains('"C:\程序 Files\MashiroBot\qq worker.ps1"')) 'worker path with spaces must be quoted'
Assert-True ($Action.Arguments.Contains('"C:\Program Files\nodejs\node.exe"')) 'Node path with spaces must be quoted'
Assert-True ($Action.Arguments.Contains('C:\用户\config\runtime.json')) 'Unicode runtime descriptor path must be retained'
$Rejected = $false
try { ConvertTo-MashiroTaskArgument "bad`nargument" | Out-Null } catch { $Rejected = $_.Exception.Message -match 'cannot contain' }
Assert-True $Rejected 'newline arguments must be rejected'
Write-Output 'PASS: scheduled-task runtime contract and quoting'
