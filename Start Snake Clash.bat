@echo off
title Snake Clash Server (port 3004)
set PORT=3004
cd /d "%~dp0snake-clash"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-running-game.ps1" -port %PORT%
:: The server writes to server.log instead of this window, so clicking in this window can never freeze the game.
start "" /b cmd /c "node server.js > server.log 2>&1"
timeout /t 2 /nobreak >nul
type server.log
start "" http://127.0.0.1:%PORT%
echo.
echo Server is running. Keep this window open while playing. (Log: server.log)
echo Close this window to stop the game.
pause >nul
