@echo off
setlocal
title Stop LRC Editor AI Aligner
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-ai-aligner.ps1"
set "exit_code=%ERRORLEVEL%"
echo.
pause
exit /b %exit_code%
