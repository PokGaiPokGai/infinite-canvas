param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $appRoot '.local'
$webDir = Join-Path $appRoot 'web'
$node = (Get-Command node -ErrorAction Stop).Source
$vite = Join-Path $webDir 'node_modules\vite\bin\vite.js'
$viteConfig = Join-Path $PSScriptRoot 'vite.config.ts'
$bridgeScript = Join-Path $PSScriptRoot 'codex-image-bridge.mjs'
$url = 'http://127.0.0.1:3000'
$bridgeUrl = 'http://127.0.0.1:3002'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$storageHeaders = @{ 'X-Infinite-Canvas-Storage' = '1' }

try { $bridgeHealth = Invoke-RestMethod "$bridgeUrl/health" } catch { $bridgeHealth = $null }
if ($bridgeHealth) {
    if ($bridgeHealth.service -ne 'infinite-canvas-codex-image' -or $bridgeHealth.version -ne 1 -or $bridgeHealth.kritaLinkVersion -ne 1) {
        throw 'Port 3002 is occupied by another application; nothing was stopped.'
    }
    Write-Output "Codex image bridge is already running at $bridgeUrl"
} else {
    $listener = [Net.Sockets.TcpClient]::new()
    try { $listener.Connect('127.0.0.1', 3002); $occupied = $true } catch { $occupied = $false } finally { $listener.Dispose() }
    if ($occupied) { throw 'Port 3002 is occupied by another application; nothing was stopped.' }
    if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) { throw 'Missing local/codex-image-bridge.mjs.' }
    $codexJs = $env:CODEX_CLI_JS
    if (-not $codexJs) {
        $codexCommand = Get-Command codex -ErrorAction Stop
        $codexJs = Join-Path (Split-Path -Parent $codexCommand.Source) 'node_modules\@openai\codex\bin\codex.js'
    }
    if (-not (Test-Path -LiteralPath $codexJs -PathType Leaf)) {
        throw 'Cannot locate the Codex CLI entry point. Set CODEX_CLI_JS to @openai/codex/bin/codex.js.'
    }
    $codexJs = (Resolve-Path -LiteralPath $codexJs).Path
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $previousCodexCli = $env:CODEX_CLI_JS
    try {
        $env:CODEX_CLI_JS = $codexJs
        $bridgeProcess = Start-Process -FilePath $node -ArgumentList ('"' + $bridgeScript + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir "codex-image-$stamp.stdout.log") -RedirectStandardError (Join-Path $stateDir "codex-image-$stamp.stderr.log") -PassThru
    } finally {
        $env:CODEX_CLI_JS = $previousCodexCli
    }
    do {
        $bridgeProcess.Refresh()
        if ($bridgeProcess.HasExited) { throw "Codex image bridge failed to start. See .local/codex-image-$stamp.stderr.log" }
        try { $bridgeHealth = Invoke-RestMethod "$bridgeUrl/health" } catch { Start-Sleep -Milliseconds 200 }
    } until ($bridgeHealth)
    if ($bridgeHealth.service -ne 'infinite-canvas-codex-image' -or $bridgeHealth.version -ne 1 -or $bridgeHealth.kritaLinkVersion -ne 1) {
        throw 'The Codex image bridge did not pass its health check.'
    }
    [ordered]@{ pid = $bridgeProcess.Id; startUtc = $bridgeProcess.StartTime.ToUniversalTime().ToString('o'); executable = $node; config = $bridgeScript; url = $bridgeUrl } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'codex-image-owner.json') -Encoding UTF8
    Write-Output "Codex image bridge is ready at $bridgeUrl"
}

$sharedHealth = Invoke-RestMethod "$bridgeUrl/storage/meta" -Headers $storageHeaders
if ($sharedHealth.schemaVersion -ne 1) { throw 'The shared local database did not pass its health check. Restart Infinite Canvas.' }
try { $page = Invoke-WebRequest $url -UseBasicParsing } catch { $page = $null }
if ($page) {
    if ($page.Content -notmatch 'id="root"') { throw 'Port 3000 is occupied by another application; nothing was stopped.' }
    $codexProxyHealth = Invoke-RestMethod "$url/codex-image/health"
    $sharedProxyHealth = Invoke-RestMethod "$url/local-data/meta" -Headers $storageHeaders
    if ($sharedProxyHealth.schemaVersion -ne 1) { throw 'The shared local data proxy is unavailable. Restart Infinite Canvas.' }
    if ($codexProxyHealth.service -ne 'infinite-canvas-codex-image' -or $codexProxyHealth.version -ne 1) {
        throw 'The service on port 3000 is not this ComfyUI and Codex image deployment.'
    }
    Write-Output "Infinite Canvas is already running at $url"
} else {
    $listener = [Net.Sockets.TcpClient]::new()
    try { $listener.Connect('127.0.0.1', 3000); $occupied = $true } catch { $occupied = $false } finally { $listener.Dispose() }
    if ($occupied) { throw 'Port 3000 is occupied by another application; nothing was stopped.' }
    if (-not (Test-Path -LiteralPath (Join-Path $webDir 'dist\index.html'))) { throw 'Missing web/dist. Build with pnpm exec vite build --config ../local/vite.config.ts first.' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $canvasArguments = @('"' + $vite + '"', 'preview', '--config', '"' + $viteConfig + '"')
    $process = Start-Process -FilePath $node -ArgumentList $canvasArguments -WorkingDirectory $webDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir "canvas-$stamp.stdout.log") -RedirectStandardError (Join-Path $stateDir "canvas-$stamp.stderr.log") -PassThru
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "Infinite Canvas failed to start. See .local/canvas-$stamp.stderr.log" }
        $sharedHealth = Invoke-RestMethod "$bridgeUrl/storage/meta" -Headers $storageHeaders
if ($sharedHealth.schemaVersion -ne 1) { throw 'The shared local database did not pass its health check. Restart Infinite Canvas.' }
try { $page = Invoke-WebRequest $url -UseBasicParsing } catch { Start-Sleep -Milliseconds 200 }
    } until ($page)
    $codexProxyHealth = Invoke-RestMethod "$url/codex-image/health"
    $sharedProxyHealth = Invoke-RestMethod "$url/local-data/meta" -Headers $storageHeaders
    if ($sharedProxyHealth.schemaVersion -ne 1) { throw 'The shared local data proxy is unavailable. Restart Infinite Canvas.' }
    if ($page.Content -notmatch 'id="root"' -or $codexProxyHealth.service -ne 'infinite-canvas-codex-image' -or $codexProxyHealth.version -ne 1) {
        throw 'The local deployment did not pass its health check.'
    }
    [ordered]@{ pid = $process.Id; startUtc = $process.StartTime.ToUniversalTime().ToString('o'); executable = $node; config = $viteConfig; url = $url } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'canvas-owner.json') -Encoding UTF8
    Write-Output "Infinite Canvas is ready at $url"
}
if (-not $NoBrowser) { Start-Process "$url/canvas" }
