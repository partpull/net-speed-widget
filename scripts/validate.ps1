# ---------------------------------------------------------------------
# net-speed-widget self-check runner
#
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate.ps1
#
# This file is intentionally ASCII-only: PowerShell 5.1 reads .ps1 files
# using the system ANSI code page, so non-ASCII text would be mangled.
#
# Uses the system node if available; otherwise falls back to the Electron
# runtime bundled with VS Code (ELECTRON_RUN_AS_NODE=1 acts like node.exe).
# ---------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$log = Join-Path $root 'validate-report.txt'

# --- decide which node to use ----------------------------------------
$nodeExe = $null

$systemNode = (Get-Command node -ErrorAction SilentlyContinue)
if ($systemNode) {
  $nodeExe = $systemNode.Source
} else {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
    'C:\Program Files\Microsoft VS Code\Code.exe',
    'C:\Program Files (x86)\Microsoft VS Code\Code.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $nodeExe = $candidate
      $env:ELECTRON_RUN_AS_NODE = '1'
      break
    }
  }
}

function Write-Log {
  param([string]$Text)
  $Text | Out-File -Append -Encoding utf8 -LiteralPath $log
}

function Invoke-Node {
  # NOTE: do not name this parameter $Args - it is a PowerShell
  # automatic variable and parameter binding will fail with it.
  param([string[]]$NodeArgs)

  $stdout = Join-Path $root 'node-stdout.tmp'
  $stderr = Join-Path $root 'node-stderr.tmp'
  Remove-Item -LiteralPath $stdout, $stderr -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $nodeExe -ArgumentList $NodeArgs -Wait -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  return @{
    Code = $process.ExitCode
    Out  = (Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue)
    Err  = (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)
  }
}

Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue

if (-not $nodeExe) {
  Write-Host '[FAIL] Node.js not found.' -ForegroundColor Red
  Write-Host '       Install it from https://nodejs.org/ and run this script again.'
  exit 1
}

Write-Log "node runtime : $nodeExe"
Write-Log "project root : $root"
Write-Log ''

# --- 1. syntax check -------------------------------------------------
Write-Log '### 1. syntax check'
$jsFiles = @(
  'src\main.js', 'src\preload.js', 'src\config.js', 'src\providers.js',
  'src\speed-monitor.js', 'src\tray-icon.js', 'src\renderer\renderer.js',
  'tools\speed-cli.js', 'tools\self-check.js'
)
foreach ($file in $jsFiles) {
  $result = Invoke-Node @('--check', $file)
  if ($result.Code -eq 0) {
    Write-Log "OK   $file"
  } else {
    Write-Log "FAIL $file :: $($result.Err)"
  }
}

# --- 2. module self-check ---------------------------------------------
Write-Log ''
Write-Log '### 2. self-check'
$result = Invoke-Node @('tools\self-check.js')
Write-Log "exit=$($result.Code)"
Write-Log $result.Out
if ($result.Err) { Write-Log "STDERR: $($result.Err)" }

# --- 3. live sampling -------------------------------------------------
Write-Log ''
Write-Log '### 3. live sampling (5s)'
$result = Invoke-Node @('tools\speed-cli.js', '5', '1000')
Write-Log "exit=$($result.Code)"
Write-Log $result.Out
if ($result.Err) { Write-Log "STDERR: $($result.Err)" }

# --- 4. tray icon png -------------------------------------------------
Write-Log ''
Write-Log '### 4. tray icon png'
$trayPng = Join-Path $root 'node-tray.tmp.png'
$result = Invoke-Node @('src\tray-icon.js', $trayPng)
Write-Log "exit=$($result.Code) $($result.Out)"
if (Test-Path -LiteralPath $trayPng) {
  Write-Log "png size = $((Get-Item -LiteralPath $trayPng).Length) bytes"
} else {
  Write-Log 'png NOT created'
}
Remove-Item -LiteralPath $trayPng -ErrorAction SilentlyContinue

# --- wrap up ----------------------------------------------------------
Remove-Item -LiteralPath (Join-Path $root 'node-stdout.tmp'), (Join-Path $root 'node-stderr.tmp') -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "report written to: $log" -ForegroundColor Cyan
Get-Content -LiteralPath $log
