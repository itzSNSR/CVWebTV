@echo off
title CineVault TV server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this PC.
  echo   Install the LTS build from https://nodejs.org/ then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   CineVault TV
echo   ------------
echo   This PC   : http://localhost:8787/
echo   Television: http://YOUR-PC-IP:8787/   (see README section 6)
echo.
echo   Keep this window open while watching. Press Ctrl+C to stop.
echo.

start "" http://localhost:8787/
node backend\server.js

echo.
echo   Server stopped.
pause
