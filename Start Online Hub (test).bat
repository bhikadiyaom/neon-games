@echo off
title Neon Arcade hub (port 3050)
set PORT=3050
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b)
start "" /b cmd /c "node hub.js > hub.log 2>&1"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%
echo Lobby with private rooms is running at http://127.0.0.1:%PORT%  (this is what goes online)
echo Keep this window open. Close it to stop.
pause >nul
