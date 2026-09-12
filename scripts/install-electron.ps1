# ---------------------------------------------------------------------
# Download the Electron binary.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-electron.ps1
#
# Why this script exists:
#   1. npm 11 no longer runs dependency postinstall scripts by default, so
#      electron's postinstall (node install.js) is skipped entirely;
#   2. that postinstall pulls ~100 MB from GitHub Releases, which frequently
#      stalls forever on networks with poor GitHub connectivity.
#
# So we run install.js ourselves and point ELECTRON_MIRROR at a mirror.
# Delete the mirror line below to use the official GitHub URL instead.
#
# This file is ASCII-only on purpose: PowerShell 5.1 reads .ps1 files using
# the system ANSI code page and would mangle non-ASCII text.
# ---------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

# Electron download mirror. Swap for
# https://github.com/electron/electron/releases/download/ to use the official URL.
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
  foreach ($candidate in @(
      'C:\Program Files\nodejs\node.exe',
      'C:\Program Files (x86)\nodejs\node.exe',
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )) {
    if (Test-Path -LiteralPath $candidate) { $nodeExe = $candidate; break }
  }
}
if (-not $nodeExe) {
  Write-Host '[FAIL] Node.js not found. Install it from https://nodejs.org/' -ForegroundColor Red
  exit 1
}

$installer = Join-Path $projectRoot 'node_modules\electron\install.js'
if (-not (Test-Path -LiteralPath $installer)) {
  Write-Host '[FAIL] node_modules\electron\install.js not found.' -ForegroundColor Red
  Write-Host '       Run "npm install" first.'
  exit 1
}

$pathFile = Join-Path $projectRoot 'node_modules\electron\path.txt'
if (Test-Path -LiteralPath $pathFile) {
  Write-Host "[SKIP] already installed: $((Get-Content -LiteralPath $pathFile -Raw).Trim())" -ForegroundColor Green
  exit 0
}

Write-Host "node   : $nodeExe"
Write-Host "mirror : $env:ELECTRON_MIRROR"
Write-Host 'downloading Electron binary (about 100 MB), please wait...'
Write-Host ''

$process = Start-Process -FilePath $nodeExe -ArgumentList @('node_modules\electron\install.js') `
  -WorkingDirectory $projectRoot -Wait -NoNewWindow -PassThru

if ((Test-Path -LiteralPath $pathFile) -and (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'))) {
  Write-Host ''
  Write-Host '[OK] Electron installed.' -ForegroundColor Green
  exit 0
}

Write-Host ''
Write-Host "[FAIL] Electron binary still missing (install.js exit=$($process.ExitCode))." -ForegroundColor Red
Write-Host '       Try another mirror, or download the zip manually and set ELECTRON_OVERRIDE_DIST_PATH.'
exit 1
