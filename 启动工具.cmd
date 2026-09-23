@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and add it to PATH.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run npm ci in this folder first.
  pause
  exit /b 1
)
if not exist "public\app.js" (
  echo Frontend build is missing. Run npm run build in this folder first.
  pause
  exit /b 1
)
node.exe "scripts\start-desktop.cjs" %*
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
