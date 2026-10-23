param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$url = 'http://127.0.0.1:3030'
$healthUrl = 'http://127.0.0.1:3032/health'
$stateDir = Join-Path $appRoot '.local\blender-preview'
$node = (Get-Command node -ErrorAction Stop).Source
try { $health = Invoke-RestMethod $healthUrl } catch { $health = $null }
if ($health) {
    if ($health.service -ne 'infinite-canvas-blender-preview' -or $health.appRoot -ne $appRoot -or -not $health.ready) {
        throw 'The preview ports belong to another checkout or startup. Nothing was stopped.'
    }
} else {
    foreach ($port in 3030,3032) {
        $client = [Net.Sockets.TcpClient]::new()
        try { $client.Connect('127.0.0.1',$port); $occupied = $true } catch { $occupied = $false } finally { $client.Dispose() }
        if ($occupied) { throw "Port $port is occupied. Nothing was stopped." }
    }
    $dependencies = Join-Path $appRoot 'web\node_modules'
    if (-not (Test-Path -LiteralPath $dependencies)) {
        $commonGit = (& git -C $appRoot rev-parse --path-format=absolute --git-common-dir).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the repository dependencies.' }
        $existingDependencies = Join-Path (Split-Path -Parent $commonGit) 'web\node_modules'
        if (-not (Test-Path -LiteralPath (Join-Path $existingDependencies 'vite\bin\vite.js'))) {
            throw 'The main checkout has no existing Vite dependencies. No packages were installed.'
        }
        New-Item -ItemType Junction -Path $dependencies -Target $existingDependencies | Out-Null
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $process = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $PSScriptRoot 'blender-preview.mjs') + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'server.stdout.log') -RedirectStandardError (Join-Path $stateDir 'server.stderr.log') -PassThru
    do {
        $process.Refresh()
        if ($process.HasExited) { throw ('Preview startup failed. See ' + (Join-Path $stateDir 'server.stderr.log')) }
        try { $health = Invoke-RestMethod $healthUrl } catch { $health = $null }
        if (-not $health.ready) { Start-Sleep -Milliseconds 200 }
    } until ($health.ready)
    if ($health.service -ne 'infinite-canvas-blender-preview' -or $health.appRoot -ne $appRoot) { throw 'Unexpected preview service identity.' }
    [ordered]@{ pid = $process.Id; appRoot = $appRoot; url = $url } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'owner.json') -Encoding UTF8
}
Write-Output "Blender branch preview is ready at $url/canvas"
if (-not $NoBrowser) { Start-Process "$url/canvas" }
