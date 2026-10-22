Option Explicit
Dim shell, files, localDirectory, appScript, powershell, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
localDirectory = files.GetParentFolderName(WScript.ScriptFullName)
appScript = files.BuildPath(localDirectory, "Open-InfiniteCanvasApp.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Quote(powershell) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Quote(appScript)
result = shell.Run(command, 0, False)

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
