$ErrorActionPreference = 'Stop'
try {
    $appRoot = Split-Path -Parent $PSScriptRoot
    $startScript = Join-Path $PSScriptRoot 'Start-InfiniteCanvas.ps1'
    $browserCandidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $browser = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $browser) { throw 'Microsoft Edge or Google Chrome is required to open the application window. No browser was installed.' }
    if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw 'Missing local/Start-InfiniteCanvas.ps1.' }
    & $startScript -NoBrowser
    $profileDirectory = Join-Path $appRoot '.local\app-window'
    New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
    $browserArguments = @(
        '--app=http://127.0.0.1:3000/canvas',
        ('--user-data-dir="' + $profileDirectory + '"'),
        '--no-first-run',
        '--no-default-browser-check'
    )
    # This window is intentionally visible; only the launcher and local services are hidden.
    Start-Process -FilePath $browser -ArgumentList $browserArguments -WorkingDirectory $appRoot -WindowStyle Normal
} catch {
    $details = $_.Exception.Message
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($details, 'Infinite Canvas', 'OK', 'Error') | Out-Null
    } catch {
        Write-Error $details
    }
    exit 1
}
