Option Explicit
Dim shell, files, script, powershell
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
script = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "Start-CanvasUX.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
shell.Run Quote(powershell) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Quote(script) & " -Instance canvas-ux-next -Port 3011", 0, False

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
