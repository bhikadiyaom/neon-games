param([int]$port = 3000)
# Stops a previous copy of one of OUR games on this port. Never touches other programs.
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { exit 0 }
$ours = $false
try {
  $r = Invoke-RestMethod -Uri "http://localhost:$port/api/settings" -TimeoutSec 3
  if ($r.settings -and $null -ne $r.isHost -and $r.defaults) { $ours = $true }
} catch {}
if ($ours) { Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Seconds 1 }
else { Write-Host "Port $port is being used by another program. Close it first, or change PORT in this start file." }
