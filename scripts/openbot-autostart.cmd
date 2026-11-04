@echo off
rem Mantiene vivo al supervisor de OpenBot: si el proceso se cae, lo relanza.
rem Lo usa la tarea programada "OpenBot" al iniciar sesion.
rem Para apagarlo de verdad: cierra-openbot.cmd (deja .logs\supervisor.stop).

if exist "%~dp0..\.logs\supervisor.stop" exit /b 0

:loop
if exist "%~dp0..\.logs\supervisor.stop" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0openbot-supervisor.ps1"
ping -n 16 127.0.0.1 >nul
goto loop
