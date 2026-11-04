@echo off
rem Puente Telegram - OpenBot (requiere TELEGRAM_BOT_TOKEN en el .env)
chcp 65001 >nul
cd /d "%~dp0"
if not exist .logs mkdir .logs
set PATH=%USERPROFILE%\.bun\bin;%PATH%
echo [%date% %time%] === Puente Telegram iniciado === >> .logs\telegram-bridge.log
bun bridge/telegram-bridge.ts >> .logs\telegram-bridge.log 2>&1
