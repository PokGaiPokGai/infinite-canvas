$ErrorActionPreference = 'Stop'
$stateDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'

function Stop-OwnedService([string]$Name, [string]$OwnerFile, [string]$ExpectedScript, [switch]$KeepActiveJobs) {
    $stateFile = Join-Path $stateDir $OwnerFile
    if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output "No $Name process is owned by this launcher."; return }
    $owner = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $process = Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
    if (-not $process) { Write-Output "$Name is already stopped."; return }
    $command = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.pid)"
    if ($process.Path -ne $owner.executable -or $process.StartTime.ToUniversalTime().Ticks -ne ([datetime]$owner.startUtc).ToUniversalTime().Ticks -or $owner.config -ne $ExpectedScript -or -not $command -or -not $command.CommandLine.Contains($ExpectedScript)) {
        throw "The $Name process no longer matches this launcher. No process was stopped."
    }
    if ($KeepActiveJobs) {
        $health = Invoke-RestMethod 'http://127.0.0.1:3002/health'
        if ($health.service -ne 'infinite-canvas-codex-image' -or $health.version -ne 1 -or $null -eq $health.activeJobs) {
            throw 'Cannot confirm Codex image bridge task status. Its process was left running.'
        }
        if ($health.activeJobs -gt 0) {
            Write-Output "Codex image bridge remains running with $($health.activeJobs) active job(s); generated images will still be saved."
            return
        }
    }
    Stop-Process -Id $process.Id
    Write-Output "$Name stopped."
}

Stop-OwnedService -Name 'Infinite Canvas' -OwnerFile 'canvas-owner.json' -ExpectedScript (Join-Path $PSScriptRoot 'vite.config.ts')
Stop-OwnedService -Name 'Codex image bridge' -OwnerFile 'codex-image-owner.json' -ExpectedScript (Join-Path $PSScriptRoot 'codex-image-bridge.mjs') -KeepActiveJobs
Write-Output 'The shared ComfyUI backend remains running.'
