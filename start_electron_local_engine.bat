@echo off
cd /d "%~dp0"
echo Binance Local Watcher Electron Local Engine v0.3
echo.
echo First launch may install Electron dependencies.
echo.
if not exist node_modules (
  npm install
)
npm start
pause
