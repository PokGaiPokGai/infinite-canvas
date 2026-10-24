@echo off
node "%~dp0local\runtime.mjs" start
if errorlevel 1 pause
