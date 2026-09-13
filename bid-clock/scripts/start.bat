@echo off
rem Keep this file ASCII-only: batch files are read using the OEM code page,
rem so non-ASCII text would show up as mojibake on non-English Windows.
setlocal

rem Always work relative to this project root (this file lives in scripts\)
cd /d "%~dp0.."

rem --- locate Node.js -------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org/ and retry.
  echo.
  pause
  exit /b 1
)

rem --- run ------------------------------------------------------------
rem scripts\start.js finds Electron (this folder first, then the parent
rem net-speed-widget folder) and launches the widget with it.
node "scripts\start.js" %*

endlocal
