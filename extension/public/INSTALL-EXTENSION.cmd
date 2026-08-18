@echo off
setlocal
title LRC Editor Media Bridge Installation
echo LRC Editor Media Bridge v0.4.3
echo.
echo This helper opens the browser extension page and this extracted directory.
echo 此工具会打开浏览器扩展管理页和当前解压目录。
echo.
echo 1. Google Chrome
echo 2. Microsoft Edge
set /p "browser_choice=Choose browser / 选择浏览器 [1/2]: "
start "" explorer.exe "%~dp0"
if "%browser_choice%"=="2" goto edge

:chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "chrome://extensions"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "chrome://extensions"
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" "chrome://extensions"
) else (
    echo Google Chrome was not found. Open chrome://extensions manually.
)
goto instructions

:edge
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "edge://extensions"
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "edge://extensions"
) else (
    echo Microsoft Edge was not found. Open edge://extensions manually.
)

:instructions
echo.
echo Enable Developer mode, select Load unpacked, then choose the opened directory.
echo 开启开发者模式，点击“加载已解压的扩展程序”，然后选择刚打开的目录。
pause
