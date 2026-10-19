#Requires -Version 5.1
<#
.SYNOPSIS
  Turns on a free public https URL for Pinball Land guests via Tailscale Funnel.
.DESCRIPTION
  Idempotent. Safe to re-run. Installs Tailscale (winget, then the stable MSI),
  starts the Tailscale service, prints a one-time login URL if this PC is not
  on a tailnet yet, and serves the guest-only port 3010 on
  https://<machine>.<tailnet>.ts.net. The Tailscale service keeps Funnel up
  across reboot. Then turn Public access on in Admin, Settings.
  Do not point Funnel at port 3000. That port is the kiosk, including admin.
.PARAMETER Port
  Guest-only port. Default 3010. The kiosk opens this beside port 3000.
#>
param(
  [int]$Port = 3010
)

$ErrorActionPreference = "Stop"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Tailscale {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\Tailscale\tailscale.exe",
    "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe"
  )
  foreach ($path in $candidates) {
    if (Test-Path $path) { return $path }
  }
  return $null
}

function Install-Tailscale {
  Write-Host "Installing Tailscale..."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    & winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189) { return }
  }
  $msi = Join-Path $env:TEMP "tailscale-setup-latest-amd64.msi"
  Write-Host "winget did not install Tailscale. Downloading the MSI..."
  Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi" -OutFile $msi
  Start-Process msiexec.exe -ArgumentList @("/i", $msi, "/qn", "/norestart") -Wait
}

if (-not (Test-Administrator)) {
  Write-Host "Run this from an Administrator Command Prompt:"
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-public-access.ps1"
  exit 1
}

$tailscale = Find-Tailscale
if (-not $tailscale) {
  Install-Tailscale
  $tailscale = Find-Tailscale
}
if (-not $tailscale) {
  throw "Tailscale is not installed. Install it from https://tailscale.com/download/windows and run this script again."
}

$service = Get-Service -Name "Tailscale" -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne "Running") {
  Start-Service -Name "Tailscale"
}

$backend = "http://127.0.0.1:$Port"
Write-Host "Using $tailscale"
Write-Host "Guest server on this PC: $backend"

$statusJson = & $tailscale status --json 2>$null
$loggedIn = $false
if ($statusJson) {
  try {
    $status = $statusJson | ConvertFrom-Json
    $loggedIn = [string]$status.BackendState -eq "Running" -and [string]$status.Self.DNSName
  } catch {
    $loggedIn = $false
  }
}

if (-not $loggedIn) {
  Write-Host ""
  Write-Host "This PC is not on a tailnet yet. Tailscale will print a login URL."
  Write-Host "Open that URL once in a browser and approve this machine. Re-run this script after it says connected."
  Write-Host ""
  & $tailscale up
}

$funnelResult = & $tailscale funnel --bg $Port 2>&1 | Out-String
$funnelCode = $LASTEXITCODE
Write-Host $funnelResult
if ($funnelCode -ne 0 -or $funnelResult -match "Funnel is not enabled") {
  $link = ""
  $found = [regex]::Match($funnelResult, "https://\S+")
  if ($found.Success) { $link = $found.Value.TrimEnd(".", ")") }
  Write-Host ""
  Write-Host "Funnel is not enabled on this tailnet, so this script did not finish."
  if ($link) {
    Write-Host "Open this link and approve Funnel:"
    Write-Host "  $link"
  } else {
    Write-Host "Open the link Tailscale printed and approve Funnel."
  }
  Write-Host "Then re-run this script:"
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-public-access.ps1"
  exit 1
}

$funnel = & $tailscale funnel status
Write-Host ""
Write-Host "Funnel is on for port $Port. It stays up when Windows restarts because the Tailscale service starts with Windows."
Write-Host $funnel
Write-Host ""
Write-Host "In Admin, Settings, turn Public access on. The status line should show https://<this-pc>.<tailnet>.ts.net"
Write-Host "Guests scan the QR on the pinboard. They do not install an app."
