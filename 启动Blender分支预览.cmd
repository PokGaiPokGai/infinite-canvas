@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local\Start-BlenderPreview.ps1"
if errorlevel 1 pause
