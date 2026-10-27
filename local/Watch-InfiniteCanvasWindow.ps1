param([Parameter(Mandatory=$true)][string]$ProfileDirectory)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CanvasWindows {
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    public static int Count(int processId) {
        int count = 0;
        EnumWindows((window, data) => {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == processId && IsWindowVisible(window)) count++;
            return true;
        }, IntPtr.Zero);
        return count;
    }
}
'@
$seenWindow = $false
do {
    $browsers = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains('--user-data-dir="' + $ProfileDirectory + '"') -and -not $_.CommandLine.Contains('--type=')
    })
    $windows = 0
    foreach ($browserProcess in $browsers) { $windows += [CanvasWindows]::Count($browserProcess.ProcessId) }
    if ($windows -gt 0) { $seenWindow = $true }
    if (($seenWindow -and $windows -eq 0) -or $browsers.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
} while ($true)
# The dedicated browser profile is not the user's normal browser profile.
foreach ($browserProcess in $browsers) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($browserProcess.ProcessId)"
    if ($current -and $current.CreationDate -eq $browserProcess.CreationDate -and $current.CommandLine.Contains('--user-data-dir="' + $ProfileDirectory + '"')) {
        & taskkill.exe /PID $current.ProcessId /T /F | Out-Null
    }
}
& node (Join-Path $PSScriptRoot 'runtime.mjs') exit-app
if ($LASTEXITCODE -ne 0) { throw '无限画布后台未能完全退出，请检查本机运行日志。' }
