@echo off
rem OpenBot - arranque en un clic para Windows.
rem Levanta Docker, deja al supervisor a cargo de todo (app, servidor, worker y puente)
rem y abre el navegador cuando la app responde.
setlocal EnableExtensions

set "ROOT=%~dp0"
cd /d "%ROOT%"

rem PATH para que Git Bash vea bun y el helper de credenciales de Docker vea su directorio
set "PATH=%USERPROFILE%\.bun\bin;C:\Program Files\Docker\Docker\resources\bin;%PATH%"

rem Anular variables globales que pisarian el .env de OpenBot
set "OPENAI_BASE_URL="
set "OPENAI_API_KEY="
set "OPENAI_API_BASE="
set "OPENAI_MODEL="

rem --- Docker Desktop ---
docker info >nul 2>&1
if not errorlevel 1 goto dockok
echo Docker Desktop no esta corriendo; iniciandolo...
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
set /a tries=0
:waitdocker
timeout /t 5 /nobreak >nul
docker info >nul 2>&1
if not errorlevel 1 goto dockok
set /a tries+=1
if %tries% lss 60 goto waitdocker
echo ERROR: el motor de Docker no respondio en 5 minutos. Revisa la ventana de Docker Desktop.
pause
exit /b 1
:dockok
echo Docker OK.

rem --- Supervisor: un solo dueno de los procesos, con reinicio automatico ---
if exist "%ROOT%.logs\supervisor.stop" del /q "%ROOT%.logs\supervisor.stop" >nul 2>&1
echo Iniciando el supervisor de OpenBot...
start "OpenBot supervisor" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%ROOT%scripts\openbot-supervisor.ps1"

rem --- Esperar la app y abrir el navegador ---
echo Esperando que la app responda en el puerto 3010 (el primer arranque compila y tarda)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 300;$i++){ try { $r=Invoke-WebRequest -Uri 'http://localhost:3010' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200 -and $r.Content -match '<title>OpenBot'){$ok=$true; break} } catch { }; Start-Sleep 2 }; if($ok){ exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo La app no respondio en http://localhost:3010 en 10 minutos.
  echo Revisa .logs\supervisor.log y .logs\stack.log: el supervisor sigue reintentando solo.
  pause
  exit /b 1
)
echo OpenBot listo en http://localhost:3010

rem --- Abrir la sesion del equipo en el navegador (el canal del puente, si existe) ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=''; try { $s = Get-Content -Raw '%ROOT%bridge\state.json' | ConvertFrom-Json; if ($s.channelUrl) { $c = $s.channelUrl } } catch { }; if ($c -eq '') { $c = 'http://localhost:3010' }; Start-Process $c"
echo El supervisor mantiene todo arriba solo. Log: .logs\supervisor.log
echo Esta ventana puede cerrarse.
ping -n 9 127.0.0.1 >nul
