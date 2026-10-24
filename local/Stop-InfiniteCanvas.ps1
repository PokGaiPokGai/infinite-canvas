$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'runtime.mjs') stop
if ($LASTEXITCODE -ne 0) { throw '停止请求未完成，未强制终止进程。' }
