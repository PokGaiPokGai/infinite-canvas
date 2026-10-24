param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'runtime.mjs') serve --no-browser
if ($LASTEXITCODE -ne 0) { throw '本机入口启动失败，请查看上方诊断。' }
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:3000/canvas' }
