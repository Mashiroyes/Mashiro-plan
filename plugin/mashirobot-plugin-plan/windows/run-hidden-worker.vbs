Option Explicit

If WScript.Arguments.Count <> 7 And WScript.Arguments.Count <> 8 Then WScript.Quit 87

Dim shell, command, exitCode
Set shell = CreateObject("WScript.Shell")
command = Quote(WScript.Arguments(0)) _
    & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(WScript.Arguments(1)) _
    & " -PluginRoot " & Quote(WScript.Arguments(2)) _
    & " -SqlitePath " & Quote(WScript.Arguments(3)) _
    & " -PeriodType " & Quote(WScript.Arguments(4)) _
    & " -JobId " & Quote(WScript.Arguments(5)) _
    & " -JobVersion " & Quote(WScript.Arguments(6))
If WScript.Arguments.Count = 8 Then
    If LCase(WScript.Arguments(7)) <> "dry-run" Then WScript.Quit 87
    command = command & " -DryRun"
End If
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
