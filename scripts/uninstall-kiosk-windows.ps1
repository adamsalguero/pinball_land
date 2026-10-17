#Requires -Version 5.1
param()
$ErrorActionPreference = "Stop"

foreach ($taskName in @("PinballLandKiosk", "PinballLandServer", "PinballLandUpdateBoot", "PinballLandUpdateNightly")) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
  } else {
    Write-Host "No scheduled task named '$taskName' was registered."
  }
}
