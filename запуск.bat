@echo off
title GitLoader
cd /d "%~dp0"

echo Checking Node.js, Git and dependencies...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 goto :setup_failed

set "PATH=%~dp0runtime\node;%~dp0runtime\git\cmd;%PATH%"

echo Starting GitLoader...
call npm start
if errorlevel 1 pause
exit /b 0

:setup_failed
echo.
echo [!] Setup failed. Check your internet connection and run this file again.
pause
exit /b 1