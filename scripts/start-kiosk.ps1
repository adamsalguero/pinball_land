#Requires -Version 5.1
# Starts Electron, and opens the wall in Chrome if that process exits early.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root
$fallback = Join-Path $PSScriptRoot "open-wall-chrome.ps1"

function Open-WallFallback([string]$Reason) {
  Write-Host $Reason
  & $fallback
  exit 0
}

$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
$kiosk = Join-Path $root "src\kiosk.js"
if (-not (Test-Path -LiteralPath $electron)) {
  Open-WallFallback "electron.exe is missing. Opening the wall in Chrome."
}

$proc = $null
try {
  $proc = Start-Process -FilePath $electron -ArgumentList @($kiosk) -WorkingDirectory $root -PassThru
} catch {
  Open-WallFallback "Electron did not start ($($_.Exception.Message)). Opening the wall in Chrome."
}
if (-not $proc) {
  Open-WallFallback "Electron did not start. Opening the wall in Chrome."
}

# LastTaskResult 0 with no windows: Electron quit before the wall existed.
# 15 seconds is long enough for a lock failure and short enough to leave a
# healthy kiosk alone.
if ($proc.WaitForExit(15000)) {
  Open-WallFallback "Electron exited early ($($proc.ExitCode)). Opening the wall in Chrome."
}

Write-Host "Electron is running."
$proc.WaitForExit()
Open-WallFallback "Electron exited ($($proc.ExitCode)). Opening the wall in Chrome."
