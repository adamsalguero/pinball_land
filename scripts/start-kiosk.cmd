@echo off
setlocal
cd /d "%~dp0\.."

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not in PATH for this user.
  echo Install Node.js LTS for all users from https://nodejs.org then reboot.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing npm packages...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Starting Pinball Land kiosk...
call npm run kiosk
