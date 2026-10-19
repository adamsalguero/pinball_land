#Requires -Version 5.1
<#
.SYNOPSIS
  Stop Pinball Land from starting at sign-in.
.DESCRIPTION
  Unregisters PinballLandServer, PinballLandKiosk, PinballLandUpdateBoot, and
  PinballLandUpdateNightly. If a task cannot be removed, it is disabled.
  Needs Administrator and self-elevates. Use this on a dev or test PC.
#>
param()

$ErrorActionPreference = "Stop"

function Test-AutostartAdmin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-AutostartAdmin)) {
  Write-Host "Administrator approval is required to remove PinballLandServer, PinballLandKiosk, PinballLandUpdateBoot, and PinballLandUpdateNightly."
  try {
    $proc = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $PSCommandPath
    )
  } catch {
    Write-Warning "Elevation was cancelled. Boot tasks were left in place."
    exit 1
  }
  if (-not $proc) { exit 1 }
  exit $(if ($null -eq $proc.ExitCode) { 1 } else { $proc.ExitCode })
}

foreach ($taskName in @("PinballLandKiosk", "PinballLandServer", "PinballLandUpdateBoot", "PinballLandUpdateNightly")) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "No scheduled task named '$taskName' was registered."
    continue
  }
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Host "Removed scheduled task '$taskName'."
  } catch {
    Write-Warning "Could not remove '$taskName' ($($_.Exception.Message)). Disabling it."
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Write-Host "Disabled scheduled task '$taskName'."
  }
}

Write-Host "Pinball Land will not start at sign-in."
