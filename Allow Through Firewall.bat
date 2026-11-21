@echo off
title Neon games - Firewall setup
:: Opens TCP ports 3000 (Neon Arena), 3002 (Neon Strike) and 3003 (Snake Clash) so other PCs can join.
net session >nul 2>nul || (
  echo Asking for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall delete rule name="Neon Arena (TCP 3000)" >nul 2>nul
netsh advfirewall firewall delete rule name="Neon games (TCP 3000,3002,3003,3004)" >nul 2>nul
netsh advfirewall firewall add rule name="Neon games (TCP 3000,3002,3003,3004)" dir=in action=allow protocol=TCP localport=3000,3002,3003,3004 profile=any
echo.
echo Done. Other computers can now join on ports 3000, 3002, 3003 and 3004.
echo To undo later:  netsh advfirewall firewall delete rule name="Neon games (TCP 3000,3002,3003,3004)"
pause
