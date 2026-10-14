Set-StrictMode -Version Latest

function ConvertTo-MashiroTaskArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    if ($Value.IndexOfAny([char[]]@("`0","`r","`n")) -ge 0) { throw 'Scheduled-task arguments cannot contain NUL or newlines.' }
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function New-MashiroTaskAction {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$WorkerPath,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $Pwsh = [IO.Path]::GetFullPath([string]$Runtime.pwshPath)
    $Worker = [IO.Path]::GetFullPath($WorkerPath)
    if (-not [IO.Path]::IsPathRooted($Pwsh) -or -not [IO.Path]::IsPathRooted($Worker)) { throw 'Task executable and worker paths must be absolute.' }
    $All = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$Worker) + @($Arguments)
    $ArgumentText = ($All | ForEach-Object { ConvertTo-MashiroTaskArgument ([string]$_) }) -join ' '
    return New-ScheduledTaskAction -Execute $Pwsh -Argument $ArgumentText
}

function Assert-MashiroTaskContract {
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$ExpectedExecute,
        [Parameter(Mandatory)][string]$ExpectedPrincipal,
        [Parameter(Mandatory)][string[]]$RequiredArguments
    )
    [xml]$Xml = Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $Ns = [Xml.XmlNamespaceManager]::new($Xml.NameTable)
    $Ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $Execute = [string]$Xml.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Command',$Ns).InnerText
    $Arguments = [string]$Xml.SelectSingleNode('/t:Task/t:Actions/t:Exec/t:Arguments',$Ns).InnerText
    $UserId = [string]$Xml.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId',$Ns).InnerText
    if (-not [IO.Path]::GetFullPath($Execute).Equals([IO.Path]::GetFullPath($ExpectedExecute), [StringComparison]::OrdinalIgnoreCase)) { throw "Task executable mismatch: $TaskName" }
    if ($UserId -notmatch [regex]::Escape($ExpectedPrincipal)) { throw "Task principal mismatch: $TaskName expected $ExpectedPrincipal, found $UserId" }
    foreach ($Required in $RequiredArguments) { if (-not $Arguments.Contains($Required)) { throw "Task argument mismatch: $TaskName missing $Required" } }
    return [ordered]@{ taskName=$TaskName; execute=$Execute; arguments=$Arguments; principal=$UserId; xml=$Xml.OuterXml }
}
