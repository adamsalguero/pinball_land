#Requires -Version 5.1
<#
.SYNOPSIS
  Installs unattended remote support. RustDesk is the default. AnyDesk is optional.
  Passwords come from the environment for this run only. Nothing is written into the repo.
#>
param(
  [ValidateSet("rustdesk", "anydesk", "tailscale")]
  [string]$Tool = "rustdesk"
)

$ErrorActionPreference = "Stop"

if ($Tool -eq "rustdesk") {
  $password = $env:RUSTDESK_PASSWORD
  if (-not $password) { throw "Set RUSTDESK_PASSWORD in the environment for this run. Do not commit it." }
  $installer = Join-Path $env:TEMP "rustdesk-installer.exe"
  Invoke-WebRequest -Uri "https://github.com/rustdesk/rustdesk/releases/download/1.3.7/rustdesk-1.3.7-x86_64.exe" -OutFile $installer
  Start-Process -FilePath $installer -ArgumentList "--silent-install" -Wait
  $exe = Join-Path $env:ProgramFiles "RustDesk\rustdesk.exe"
  if (Test-Path $exe) {
    & $exe --password $password | Out-Null
    Write-Host "RustDesk unattended password was set from the environment."
    Write-Host "ID: $(& $exe --get-id)"
  }
  exit 0
}

if ($Tool -eq "anydesk") {
  if (-not $env:ANYDESK_PASSWORD) { throw "Set ANYDESK_PASSWORD in the environment for this run. Do not commit it." }
  Write-Host "Download AnyDesk from https://anydesk.com and enable Unattended Access with ANYDESK_PASSWORD."
  Write-Host "Do not save that password in this repository."
  exit 0
}

Write-Host "Tailscale: install from https://tailscale.com/download/windows"
Write-Host "Then: tailscale up"
Write-Host "The admin app is https://<tailscale-ip>:3443/admin and SSH/RDP stay on the tailnet."
Write-Host "Tailscale CGNAT addresses (100.64.0.0/10) are treated as local by the kiosk."
