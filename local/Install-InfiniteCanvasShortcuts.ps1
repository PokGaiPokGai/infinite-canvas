param([switch]$Desktop, [switch]$StartMenu)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'Launch-InfiniteCanvasApp.vbs'
$icon = Join-Path $PSScriptRoot 'infinite-canvas.ico'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcutArguments = '"' + $launcher + '"'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Missing local/Launch-InfiniteCanvasApp.vbs.' }
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Missing local/infinite-canvas.ico.' }
if (-not $Desktop -and -not $StartMenu) { $Desktop = $true; $StartMenu = $true }
$shell = New-Object -ComObject WScript.Shell
$targets = @()
if ($Desktop) { $targets += Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Infinite Canvas.lnk' }
if ($StartMenu) { $targets += Join-Path ([Environment]::GetFolderPath('Programs')) 'Infinite Canvas.lnk' }
# Preflight every target before creating anything. An existing different shortcut is never replaced.
foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $target) -PathType Container)) { throw "Shortcut directory is unavailable: $target" }
    if (Test-Path -LiteralPath $target) {
        $existing = $shell.CreateShortcut($target)
        if ($existing.TargetPath -ne $wscript -or $existing.Arguments -ne $shortcutArguments) {
            throw "A different shortcut already exists; nothing was replaced: $target"
        }
    }
}
foreach ($target in $targets) {
    if (Test-Path -LiteralPath $target) { Write-Output "Shortcut already exists and was left unchanged: $target"; continue }
    $shortcut = $shell.CreateShortcut($target)
    $shortcut.TargetPath = $wscript
    $shortcut.Arguments = $shortcutArguments
    $shortcut.WorkingDirectory = $appRoot
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = 'Infinite Canvas - local application window'
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    Write-Output "Shortcut created: $target"
}
