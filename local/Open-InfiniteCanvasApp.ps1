$ErrorActionPreference = 'Stop'
try {
    $appRoot = Split-Path -Parent $PSScriptRoot
    $startScript = Join-Path $PSScriptRoot 'Start-InfiniteCanvas.ps1'
    if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw 'Missing local/Start-InfiniteCanvas.ps1.' }
    & $startScript
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
