#Requires -Version 5.1
<#
.SYNOPSIS
  Registers Pinball Land kiosk auto-start on Windows 11 (Task Scheduler at logon).
.NOTES
  Re-runnable. Does not enable auto-logon (do that with netplwiz). Does not change BIOS.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$taskName = "PinballLandKiosk"
$cmdPath = Join-Path $RepoRoot "scripts\start-kiosk.cmd"

if (-not (Test-Path $cmdPath)) {
  throw "Missing $cmdPath"
}

Write-Host "Repo: $RepoRoot"
Write-Host "Registering scheduled task '$taskName' to run at logon..."

$action = New-ScheduledTaskAction -Execute $cmdPath -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

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
Write-Host "  4. Allow Node on firewall port 3000 when Windows asks."
Write-Host "  5. Sign out and back in, or run scripts\start-kiosk.cmd to test now."
Write-Host ""
Write-Host "Uninstall later with:  powershell -File scripts\uninstall-kiosk-windows.ps1"
