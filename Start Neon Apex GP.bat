@echo off
title Neon Apex GP Server (port 3006)
set PORT=3006
cd /d "%~dp0apex-racing"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-running-game.ps1" -port %PORT%
:: The server writes to server.log instead of this window, so clicking in this window can never freeze the game.
start "" /b cmd /c "node server.js > server.log 2>&1"
timeout /t 2 /nobreak >nul
type server.log
:: WebGPU only runs on secure pages, so open 127.0.0.1 (not a LAN address). Friends join through the online hub.
start "" http://127.0.0.1:%PORT%
echo.
echo Server is running. Keep this window open while playing. (Log: server.log)
echo Close this window to stop the game.
pause >nul
