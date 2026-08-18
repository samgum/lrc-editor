@echo off
setlocal
title LRC Editor AI Aligner Setup
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-ai-aligner.ps1"
set "exit_code=%ERRORLEVEL%"
echo.
if not "%exit_code%"=="0" echo Installation did not complete. Review the message above.
pause
exit /b %exit_code%
