Option Explicit

If WScript.Arguments.Count <> 5 Then WScript.Quit 87

Dim shell, command, exitCode
Set shell = CreateObject("WScript.Shell")

command = Quote(WScript.Arguments(0)) _
    & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(WScript.Arguments(1)) _
    & " -RuntimeRoot " & Quote(WScript.Arguments(2)) _
    & " -SqlitePath " & Quote(WScript.Arguments(3))
If Len(WScript.Arguments(4)) > 0 Then
    command = command & " -CourseType " & Quote(WScript.Arguments(4))
End If

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
