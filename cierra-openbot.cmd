@echo off
rem Cierre ordenado del supervisor, el puente y el stack de OpenBot.
rem El navegador del bot conserva sus sesiones (--keep-computers).
rem Deja .logs\supervisor.stop para que la tarea programada no lo reviva.
chcp 65001 >nul
cd /d "%~dp0"
set PATH=%USERPROFILE%\.bun\bin;%PATH%
echo Deteniendo supervisor...
powershell -NoProfile -ExecutionPolicy Bypass -Command "New-Item -ItemType File -Force -Path '%~dp0.logs\supervisor.stop' | Out-Null; $n = 'openbot-' + 'supervisor.ps1'; Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like ('*' + $n + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 3 /nobreak >nul
echo Cerrando puente y stack...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \"$($_.CommandLine)\" -like '*telegram-bridge*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
bash -e -c "export PATH=\"$HOME/.bun/bin;C:/Program Files/Docker/Docker/resources/bin:$PATH\" && bash scripts/stop.sh --keep-computers"
echo Cerrado. Para volver a arrancar, usa start-openbot.cmd.
pause
