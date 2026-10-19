#Requires -Version 5.1
<#
.SYNOPSIS
  Register Pinball Land to start at sign-in.
.DESCRIPTION
  Registers PinballLandServer, PinballLandKiosk, PinballLandUpdateBoot, and
  PinballLandUpdateNightly for the signed-in user. Needs Administrator and
  self-elevates. Dev and test PCs should run scripts\disable-autostart.ps1 instead.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

function Test-AutostartAdmin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-AutostartAdmin)) {
  Write-Host "Administrator approval is required to register PinballLandServer, PinballLandKiosk, PinballLandUpdateBoot, and PinballLandUpdateNightly."
  try {
    $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $PSCommandPath,
      "-RepoRoot", $RepoRoot
    )
  } catch {
    Write-Warning "Elevation was cancelled. Boot tasks were not registered."
    exit 1
  }
  if (-not $proc) { exit 1 }
  exit $(if ($null -eq $proc.ExitCode) { 1 } else { $proc.ExitCode })
}

& (Join-Path $PSScriptRoot "register-update-tasks.ps1") -RepoRoot $RepoRoot
Write-Host "Pinball Land will start at sign-in."
