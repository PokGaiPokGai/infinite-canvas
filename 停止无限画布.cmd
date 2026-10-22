@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local\Stop-InfiniteCanvas.ps1"
if errorlevel 1 pause
