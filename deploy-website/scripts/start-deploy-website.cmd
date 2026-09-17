@echo off
setlocal
cd /d "%~dp0.."
echo [1/2] Deploy Website Node baslatiliyor...
start "Deploy Website Node" cmd /k "cd /d %~dp0.. && npm start"
timeout /t 3 /nobreak >nul
echo [2/2] Cloudflare Tunnel baslatiliyor: YOUR_TUNNEL_NAME
where cloudflared >nul 2>&1
if errorlevel 1 (
  echo.
  echo [HATA] cloudflared PATH icinde bulunamadi.
  echo Node paneli yine calisir: http://127.0.0.1:3000
  pause
  exit /b 1
)
cloudflared tunnel run YOUR_TUNNEL_NAME
pause
