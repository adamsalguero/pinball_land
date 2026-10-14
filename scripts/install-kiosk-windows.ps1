#Requires -Version 5.1
<#
.SYNOPSIS
  Registers Pinball Land kiosk auto-start on Windows 11 (Task Scheduler at logon).
.NOTES
  Re-runnable. Does not enable auto-logon (do that with netplwiz). Does not change BIOS.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$Verify
)

$ErrorActionPreference = "Stop"
$taskName = "PinballLandKiosk"
$serverTask = "PinballLandServer"

if ($Verify) {
  $kiosk = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $server = Get-ScheduledTask -TaskName $serverTask -ErrorAction SilentlyContinue
  $scheme = powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
  Write-Host "Kiosk task:  $(if ($kiosk) { 'present' } else { 'MISSING' })"
  Write-Host "Server task: $(if ($server) { 'present' } else { 'MISSING' })"
  if (-not $kiosk -or -not $server) { exit 1 }
  Write-Host "Power query answered. See KIOSK.md if the display still sleeps."
  exit 0
}
$cmdPath = Join-Path $RepoRoot "scripts\start-kiosk.cmd"

if (-not (Test-Path $cmdPath)) {
  throw "Missing $cmdPath"
}

Write-Host "Repo: $RepoRoot"
Write-Host "Registering scheduled task '$taskName' to run at logon..."

$action = New-ScheduledTaskAction -Execute $cmdPath -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT20S"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

$serverAction = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$RepoRoot\src\server.js`"" -WorkingDirectory $RepoRoot
$serverTrigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName $serverTask -Action $serverAction -Trigger $serverTrigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$serverTask' at logon and '$taskName' 20 seconds later, with restart-on-failure."

Write-Host "Hiding notifications, the screensaver, and update reboots during open hours..."
New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications" -Name "ToastEnabled" -Value 0
New-Item -Path "HKCU:\Control Panel\Desktop" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveActive" -Value "0"
# Active hours: Windows Update should not reboot while the venue is open. Adjust in Settings if close time changes.
New-Item -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursStart" -Value 9 -ErrorAction SilentlyContinue
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursEnd" -Value 23 -ErrorAction SilentlyContinue

Write-Host "Setting AC power: never sleep, never turn off display..."
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0 | Out-Null
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 0 | Out-Null
powercfg /SETACTIVE SCHEME_CURRENT | Out-Null

Write-Host ""
Write-Host "Done. Next steps (one-time):"
Write-Host "  1. BIOS Auto Power On after AC restore (see KIOSK.md)."
Write-Host "  2. Auto-logon: Win+R -> netplwiz -> uncheck 'Users must enter a user name and password'."
Write-Host "  3. BenQ OSD: System -> Switch on state = On."
Write-Host "  4. Allow Node on private networks for ports 3000 and 3443 when Windows asks."
Write-Host "  5. Sign out and back in, or run scripts\start-kiosk.cmd to test now."
Write-Host ""
Write-Host "Uninstall later with:  powershell -File scripts\uninstall-kiosk-windows.ps1"
