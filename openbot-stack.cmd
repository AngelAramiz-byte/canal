@echo off
rem Lancador interno: espera el motor de Docker y corre scripts/start.sh con Git Bash, abrienda la ventana.
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.bun\bin;C:\Program Files\Docker\Docker\resources\bin;%PATH%"

rem Si Docker Desktop no corre, arrancarlo y esperar (hasta 8 min)
docker info >nul 2>&1
if not errorlevel 1 goto dockok
echo Docker Desktop no corre; iniciandolo...
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
set /a tries=0
:waitdocker
timeout /t 5 /nobreak >nul
docker info >nul 2>&1
if not errorlevel 1 goto dockok
set /a tries+=1
echo    esperando el motor de Docker... (%tries%)
if %tries% lss 96 goto waitdocker
echo ERROR: el motor de Docker no respondio en 8 minutos.
pause
exit /b 1
:dockok
echo Docker OK.

rem Si el motor esta activo pero Docker Desktop sigue cargando el backend, reintentar compose lo cubre start.sh
call "C:\Program Files\Git\bin\bash.exe" scripts/start.sh
echo.
echo El stack OPENBOT termino (eliges cerrar esta ventana o dejarla abierta para ver el log).
pause
