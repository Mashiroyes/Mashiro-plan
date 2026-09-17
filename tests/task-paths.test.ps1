[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PlanRoot = Split-Path -Parent $PSScriptRoot
$HealthScript = Join-Path $PlanRoot 'core\health\check-mashirobot.ps1'
$FixtureRoot = Join-Path $PSScriptRoot 'fixtures\task-paths'
$NewWindowsRoot = Join-Path $PlanRoot 'plugin\mashirobot-plugin-plan\windows'
$OldRootPattern = [regex]::Escape((Join-Path $PlanRoot 'script'))
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('MashiroBot-task-path-test-' + [guid]::NewGuid().ToString('N'))

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Read-TaskProjection {
    param([string]$Path)
    [xml]$Xml = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    $Namespace = [System.Xml.XmlNamespaceManager]::new($Xml.NameTable)
    $Namespace.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    $Node = { param($XPath) $Xml.SelectSingleNode($XPath, $Namespace).'#text' }
    return [ordered]@{
        Uri = & $Node '/t:Task/t:RegistrationInfo/t:URI'
        UserId = & $Node '/t:Task/t:Principals/t:Principal/t:UserId'
        LogonType = & $Node '/t:Task/t:Principals/t:Principal/t:LogonType'
        StartWhenAvailable = & $Node '/t:Task/t:Settings/t:StartWhenAvailable'
        WakeToRun = & $Node '/t:Task/t:Settings/t:WakeToRun'
        TriggerXml = $Xml.SelectSingleNode('/t:Task/t:Triggers', $Namespace).OuterXml
        Command = & $Node '/t:Task/t:Actions/t:Exec/t:Command'
        Arguments = & $Node '/t:Task/t:Actions/t:Exec/t:Arguments'
    }
}

New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
try {
    $Cases = @(
        @{ Name = 'OpenClaw-Plan-20260803-14ccba2f.xml'; Target = Join-Path $NewWindowsRoot 'plan-reminder-worker.ps1' }
    )

    foreach ($Case in $Cases) {
        $Input = Join-Path $FixtureRoot $Case.Name
        $Output = Join-Path $TempRoot $Case.Name
        $Before = Read-TaskProjection -Path $Input

        & pwsh.exe -NoProfile -File $HealthScript -RewriteFixture -FixturePath $Input -FixtureOutput $Output | Out-Null
        Assert-True ($LASTEXITCODE -eq 0) "Fixture rewrite failed for $($Case.Name)."
        Assert-True (Test-Path -LiteralPath $Output -PathType Leaf) "Fixture output is missing for $($Case.Name)."

        $After = Read-TaskProjection -Path $Output
        foreach ($Field in @('Uri','UserId','LogonType','StartWhenAvailable','WakeToRun','TriggerXml','Command')) {
            Assert-True ($Before[$Field] -ceq $After[$Field]) "$Field changed for $($Case.Name)."
        }
        Assert-True ($After.Arguments -notmatch $OldRootPattern) "Old plan script root remains in $($Case.Name)."
        Assert-True ($After.Arguments.Contains(('"' + $Case.Target + '"'))) "New -File path is absent for $($Case.Name)."

        Assert-True ($After.Arguments.Contains('-ItemId "14ccba2f-dd61-4c61-8315-0b5e45eaeced"')) 'Plan item ID changed.'
        Assert-True ($After.Arguments.Contains('-TaskName "OpenClaw-Plan-20260803-14ccba2f"')) 'Plan task name changed.'
    }

    Write-Output 'task-paths.test.ps1: PASS'
} finally {
    if (Test-Path -LiteralPath $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
}
