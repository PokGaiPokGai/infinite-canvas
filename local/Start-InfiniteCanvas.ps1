param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$ErrorActionPreference = 'Continue'
try {
    $startOutput = & node (Join-Path $PSScriptRoot 'runtime.mjs') serve --no-browser 2>&1
    $startExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = 'Stop'
}
if ($startExitCode -ne 0) { throw ("本机入口启动失败：`n" + ($startOutput -join "`n")) }
$startOutput | Write-Output
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:3000/canvas' }
