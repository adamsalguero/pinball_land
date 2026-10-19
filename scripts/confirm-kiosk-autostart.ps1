#Requires -Version 5.1
<#
.SYNOPSIS
  Decide whether this PC should register Pinball Land boot tasks.
.DESCRIPTION
  Dot-source this file. Confirm-KioskAutostart returns $true only when -Kiosk
  was passed or the person at an interactive console answers yes. The default
  answer is no, so a dev or test PC does not start the wall at sign-in.
#>

function Confirm-KioskAutostart {
  param(
    [switch]$Kiosk,
    [switch]$DryRun
  )
  if ($Kiosk) { return $true }
  if ($DryRun -or $env:CI -eq "true") { return $false }
  $interactive = $false
  try {
    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  } catch {
    $interactive = $false
  }
  if (-not $interactive) { return $false }
  Write-Host "Dev and test PCs should not start Pinball Land at sign-in."
  Write-Host "Yes registers PinballLandServer, PinballLandKiosk, PinballLandUpdateBoot, and PinballLandUpdateNightly."
  $answer = Read-Host "Start at sign-in? [y/N]"
  return $answer -match '^(y|yes)$'
}
