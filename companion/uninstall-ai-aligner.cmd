@echo off
setlocal
title Uninstall LRC Editor AI Aligner
set "uninstall_script=%~dp0uninstall-ai-aligner.ps1"
cd /d "%TEMP%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%uninstall_script%"
set "exit_code=%ERRORLEVEL%"
echo.
pause
exit /b %exit_code%
