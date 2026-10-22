$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'krita-plugin'
$resourceRoot = Join-Path $env:APPDATA 'krita'
$pluginsRoot = Join-Path $resourceRoot 'pykrita'
$settingsPath = Join-Path $env:LOCALAPPDATA 'kritarc'
$stateRoot = Join-Path $appRoot '.local\krita-link'
$backupRoot = Join-Path $appRoot '.local\before-krita-v1-20261022'
$connectionPath = Join-Path $stateRoot 'connection.json'
$nativePath = Join-Path $resourceRoot 'infinite_canvas_bridge.json'
$utf8 = New-Object Text.UTF8Encoding($false)
if (Get-Process krita -ErrorAction SilentlyContinue) { throw 'Save your artwork and close Krita once before installing its bridge plugin.' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'infinite_canvas_bridge.desktop'))) { throw 'Missing Krita bridge plugin source.' }
New-Item -ItemType Directory -Path $stateRoot, $pluginsRoot, $backupRoot -Force | Out-Null
if (Test-Path -LiteralPath $connectionPath) {
    $connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
    if ($connection.version -ne 1 -or $connection.port -ne 3003 -or $connection.token -notmatch '^[0-9a-f]{64}$') { throw 'Existing bridge configuration is incompatible; nothing was replaced.' }
} else {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $connection = [ordered]@{ version = 1; port = 3003; token = ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()) }
    [IO.File]::WriteAllText($connectionPath, ($connection | ConvertTo-Json), $utf8)
}
if (Test-Path -LiteralPath $nativePath) {
    $native = Get-Content -LiteralPath $nativePath -Raw | ConvertFrom-Json
    if ($native.version -ne 1 -or $native.port -ne $connection.port -or $native.token -ne $connection.token) { throw 'A different Krita bridge configuration exists; nothing was replaced.' }
} else {
    [IO.File]::WriteAllText($nativePath, ($connection | ConvertTo-Json), $utf8)
}
$targetPlugin = Join-Path $pluginsRoot 'infinite_canvas_bridge'
if (Test-Path -LiteralPath $targetPlugin) {
    $oldPlugin = Join-Path $backupRoot 'infinite_canvas_bridge'
    if (-not (Test-Path -LiteralPath $oldPlugin)) { Copy-Item -LiteralPath $targetPlugin -Destination $oldPlugin -Recurse }
}
Copy-Item -LiteralPath (Join-Path $source 'infinite_canvas_bridge.desktop') -Destination (Join-Path $pluginsRoot 'infinite_canvas_bridge.desktop') -Force
New-Item -ItemType Directory -Path $targetPlugin -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $source 'infinite_canvas_bridge') -File -Filter '*.py' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetPlugin $_.Name) -Force }
if (Test-Path -LiteralPath $settingsPath) {
    $settingsBackup = Join-Path $backupRoot 'kritarc'
    if (-not (Test-Path -LiteralPath $settingsBackup)) { Copy-Item -LiteralPath $settingsPath -Destination $settingsBackup }
    $text = Get-Content -LiteralPath $settingsPath -Raw
} else { $text = '' }
if ($text -match '(?m)^enable_infinite_canvas_bridge=') {
    $text = [regex]::Replace($text, '(?m)^enable_infinite_canvas_bridge=[^\r\n]*', 'enable_infinite_canvas_bridge=true')
} elseif ($text -match '(?m)^\[python\]\r?$') {
    $text = [regex]::Replace($text, '(?m)^\[python\]\r?$', "[python]`r`nenable_infinite_canvas_bridge=true")
} else { $text += "`r`n[python]`r`nenable_infinite_canvas_bridge=true`r`n" }
[IO.File]::WriteAllText($settingsPath, $text, $utf8)
Write-Output 'Krita bridge installed and enabled. Open Krita normally; use Read Krita in Infinite Canvas. Private connection configuration stays on this machine.'
