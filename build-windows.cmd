@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-windows.ps1"
if errorlevel 1 (echo Build failed. Please review the error above.)
pause
