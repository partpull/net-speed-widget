@echo off
rem Keep this file ASCII-only: batch files are read using the OEM code page,
rem so non-ASCII text would show up as mojibake on non-English Windows.
setlocal

rem Always work relative to the project root (this file lives in scripts\)
cd /d "%~dp0.."

rem --- locate Node.js -------------------------------------------------
rem `where node` alone is not enough: if Node was installed after the
rem current shell started, the shell still has a stale PATH.
set "NODE_DIR="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_DIR set "NODE_DIR=%%~dpi"

if not defined NODE_DIR if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles%\nodejs\"
if not defined NODE_DIR if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_DIR=%ProgramFiles(x86)%\nodejs\"
if not defined NODE_DIR if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_DIR=%LOCALAPPDATA%\Programs\nodejs\"

if not defined NODE_DIR (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org/ and retry.
  echo.
  pause
  exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
echo Node.js: %NODE_DIR%

rem --- dependencies ---------------------------------------------------
if not exist "node_modules\electron" (
  echo First run: installing dependencies ^(about 100 MB^)...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check your network connection and retry.
    pause
    exit /b 1
  )
)

rem npm 11 no longer runs electron's postinstall, and the GitHub download is
rem often blocked. Download the binary explicitly (uses a mirror by default).
if not exist "node_modules\electron\path.txt" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-electron.ps1"
  if errorlevel 1 (
    echo.
    pause
    exit /b 1
  )
)

rem --- run ------------------------------------------------------------
if exist "node_modules\.bin\electron.cmd" (
  call "node_modules\.bin\electron.cmd" . %*
) else (
  call npx electron . %*
)

endlocal
