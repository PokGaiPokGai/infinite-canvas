param([switch]$NoBrowser, [string]$Instance = 'canvas-ux', [int]$Port = 3010)
$ErrorActionPreference = 'Stop'
try {
    $appRoot = Split-Path -Parent $PSScriptRoot
    $webDir = Join-Path $appRoot 'web'
    $stateDir = Join-Path $appRoot '.local'
    $modules = Join-Path $webDir 'node_modules'
    $url = "http://127.0.0.1:$Port"
    $node = (Get-Command node -ErrorAction Stop).Source
    $commonGit = & git -C $appRoot rev-parse --path-format=absolute --git-common-dir
    if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the main checkout.' }
    $mainRoot = Split-Path -Parent $commonGit

    if (-not (Test-Path -LiteralPath $modules)) {
        $mainWeb = Join-Path $mainRoot 'web'
        $mainModules = Join-Path $mainWeb 'node_modules'
        if (-not (Test-Path -LiteralPath $mainModules)) { throw 'The main checkout dependencies are missing.' }
        if ((Get-FileHash (Join-Path $webDir 'pnpm-lock.yaml')).Hash -ne (Get-FileHash (Join-Path $mainWeb 'pnpm-lock.yaml')).Hash) {
            throw 'Dependency locks differ. Prepare this worktree dependencies before launching.'
        }
        New-Item -ItemType Junction -Path $modules -Target $mainModules | Out-Null
    }

    $vite = Join-Path $modules 'vite\bin\vite.js'
    $config = Join-Path $PSScriptRoot "vite.$Instance.config.ts"
    if (-not (Test-Path -LiteralPath $vite)) { throw 'Vite is missing from the project dependencies.' }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    try { $bridge = Invoke-RestMethod 'http://127.0.0.1:3002/health' } catch { $bridge = $null }
    if (-not $bridge) {
        $listener = [Net.Sockets.TcpClient]::new()
        try { $listener.Connect('127.0.0.1', 3002); $occupied = $true } catch { $occupied = $false } finally { $listener.Dispose() }
        if ($occupied) { throw 'Port 3002 is occupied by another process. Nothing was stopped.' }
        $bridgeScript = Join-Path $PSScriptRoot 'codex-image-bridge.mjs'
        $codexJs = $env:CODEX_CLI_JS
        if (-not $codexJs) {
            $codexJs = Join-Path (Split-Path -Parent (Get-Command codex -ErrorAction Stop).Source) 'node_modules\@openai\codex\bin\codex.js'
        }
        if (-not (Test-Path -LiteralPath $codexJs -PathType Leaf)) { throw 'Cannot locate the existing Codex CLI entry point.' }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $previousCodexCli = $env:CODEX_CLI_JS
        $previousDataRoot = $env:INFINITE_CANVAS_APP_ROOT
        try {
            $env:CODEX_CLI_JS = $codexJs
            $env:INFINITE_CANVAS_APP_ROOT = $mainRoot
            $bridgeProcess = Start-Process -FilePath $node -ArgumentList ('"' + $bridgeScript + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir "codex-image-$stamp.stdout.log") -RedirectStandardError (Join-Path $stateDir "codex-image-$stamp.stderr.log") -PassThru
        } finally {
            $env:CODEX_CLI_JS = $previousCodexCli
            $env:INFINITE_CANVAS_APP_ROOT = $previousDataRoot
        }
        [ordered]@{ pid = $bridgeProcess.Id; startUtc = $bridgeProcess.StartTime.ToUniversalTime().ToString('o'); executable = $node; config = $bridgeScript; dataRoot = $mainRoot; url = 'http://127.0.0.1:3002' } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'codex-image-owner.json') -Encoding UTF8
        do {
            $bridgeProcess.Refresh()
            if ($bridgeProcess.HasExited) { throw "The shared bridge stopped. Check .local/codex-image-$stamp.stderr.log." }
            try { $bridge = Invoke-RestMethod 'http://127.0.0.1:3002/health' } catch { Start-Sleep -Milliseconds 200 }
        } until ($bridge)
    }
    if ($bridge.service -ne 'infinite-canvas-codex-image' -or $bridge.version -ne 1 -or $bridge.kritaLinkVersion -ne 1) {
        throw 'Port 3002 is not the expected local canvas service. Nothing was stopped.'
    }
    $ownerPath = Join-Path $stateDir "$Instance-owner.json"
    $process = $null
    if (Test-Path -LiteralPath $ownerPath) {
        $owner = Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
        $candidate = Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.StartTime.ToUniversalTime().Ticks -eq ([datetime]$owner.startUtc).ToUniversalTime().Ticks -and $candidate.Path -eq $node -and $owner.config -eq $config) {
            $process = $candidate
        }
    }
    if (-not $process) {
        $client = [Net.Sockets.TcpClient]::new()
        try { $client.Connect('127.0.0.1', $Port); $occupied = $true } catch { $occupied = $false } finally { $client.Dispose() }
        if ($occupied) { throw "Port $Port is occupied by another process. Nothing was stopped." }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $logPath = Join-Path $stateDir "$Instance-$stamp"
        $arguments = @('"' + $vite + '"', '--config', '"' + $config + '"', '--host', '127.0.0.1', '--port', $Port, '--strictPort')
        $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $webDir -WindowStyle Hidden -RedirectStandardOutput "$logPath.stdout.log" -RedirectStandardError "$logPath.stderr.log" -PassThru
        [ordered]@{ pid = $process.Id; startUtc = $process.StartTime.ToUniversalTime().ToString('o'); config = $config } |
            ConvertTo-Json | Set-Content -LiteralPath $ownerPath -Encoding UTF8
    }
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "The $Instance server stopped. Check .local/$Instance-*.log." }
        try { $page = Invoke-WebRequest "$url/canvas" -UseBasicParsing } catch { Start-Sleep -Milliseconds 200 }
    } until ($page)
    if ($page.Content -notmatch '/@vite/client') { throw "Port $Port did not return the development canvas." }
    $identity = Invoke-RestMethod "$url/__$Instance"
    $storage = Invoke-RestMethod "$url/local-data/meta" -Headers @{ 'X-Infinite-Canvas-Storage' = '1' }
    $krita = Invoke-RestMethod "$url/krita-link/status" -Headers @{ 'X-Infinite-Canvas-Krita-UI' = '1' }
    if ($identity.branch -ne $Instance -or -not $identity.sharedStorage -or $storage.schemaVersion -ne 1 -or $krita.connected -isnot [bool] -or ($krita.connected -and $krita.version -ne 1)) {
        throw 'Branch identity, shared storage, or Krita service validation failed.'
    }
    Write-Output "$Instance is ready at $url/canvas"
    if (-not $NoBrowser) { Start-Process "$url/canvas" }
} catch {
    if ($NoBrowser) { throw }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'Canvas UX', 'OK', 'Error') | Out-Null
    exit 1
}
