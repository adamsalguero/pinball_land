#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot registration for a Beelink that already has Pinball Land installed.
.DESCRIPTION
  Does not reinstall Node, npm packages, or venue data.
  Adds the node.exe inbound UDP firewall rule Kasa plug discovery needs on Private and Public networks.
  Registers the boot and nightly update tasks only with -Kiosk, or when an interactive
  console answers yes. Dev and test PCs should leave -Kiosk off.
  Pass -RustDeskPassword (or -RustDesk and answer the prompt) to install the latest RustDesk
  as a Windows service. -DryRun does not download RustDesk or prompt, and it registers
  boot tasks only when -Kiosk is also set.
.PARAMETER Kiosk
  Register PinballLandServer, PinballLandKiosk, PinballLandUpdateBoot, and PinballLandUpdateNightly.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$DryRun,
  [switch]$Kiosk,
  [switch]$RustDesk,
  [string]$RustDeskPassword
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

. (Join-Path $PSScriptRoot "confirm-kiosk-autostart.ps1")
$registerAutostart = Confirm-KioskAutostart -Kiosk:$Kiosk -DryRun:$DryRun
if ($registerAutostart) {
  & (Join-Path $PSScriptRoot "register-update-tasks.ps1") -RepoRoot $RepoRoot
} else {
  Write-Host "Boot tasks were not registered. Dev and test PCs stay manual."
  Write-Host "On the venue PC, pass -Kiosk or run scripts\enable-autostart.ps1."
}

$wantRust = $false
if ($RustDesk) { $wantRust = $true }
if ($RustDeskPassword) { $wantRust = $true }

if ($wantRust -and $DryRun) {
  Write-Host "Dry run: RustDesk will not be downloaded and the password will not be prompted."
} elseif ($wantRust) {
  if (-not $RustDeskPassword -and $env:RUSTDESK_PASSWORD) {
    $RustDeskPassword = $env:RUSTDESK_PASSWORD
  }
  if (-not $RustDeskPassword) {
    $secure = Read-Host -AsSecureString "RustDesk permanent password"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $RustDeskPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
  if (-not $RustDeskPassword) {
    throw "RustDesk needs a permanent password. Pass -RustDeskPassword or set RUSTDESK_PASSWORD for this run."
  }
  & (Join-Path $PSScriptRoot "install-remote-support.ps1") -Tool rustdesk -RustDeskPassword $RustDeskPassword
}

if (-not $DryRun) {
  $plugRule = "Pinball Land plug discovery"
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeExe = if ($nodeCmd) { $nodeCmd.Source } else { $null }
  if (-not $nodeExe) {
    Write-Warning "node.exe was not found, so '$plugRule' was not added."
  } else {
    & netsh.exe advfirewall firewall delete rule "name=$plugRule" | Out-Null
    $added = & netsh.exe advfirewall firewall add rule "name=$plugRule" dir=in action=allow program="$nodeExe" protocol=UDP profile=private,public enable=yes | Out-String
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Could not add firewall rule '$plugRule' for node.exe inbound UDP. $added"
    } else {
      Write-Host "Firewall rule '$plugRule' allows node.exe inbound UDP on Private and Public networks."
    }
  }
}

Write-Host ""
if ($registerAutostart) {
  Write-Host "Automatic updates are registered."
  Write-Host "At sign-in the PC checks GitHub main before the server starts. Nightly default is 3:17 AM local (config.json updates.nightlyAt)."
  Write-Host "A failed update rolls back. Scores, photos, and settings in ProgramData are not deleted."
  Write-Host "Restart so the wall comes back fullscreen:"
  Write-Host "  shutdown /r /t 0"
} else {
  Write-Host "Automatic updates were not registered, so this PC will not start the wall at sign-in."
}
