#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot registration for a Beelink that already has Pinball Land installed.
.DESCRIPTION
  Does not reinstall Node, npm packages, firewall rules, or venue data.
  Registers the boot and nightly update tasks. Pass -RustDeskPassword (or -RustDesk and
  answer the prompt) to install the latest RustDesk as a Windows service.
  -DryRun registers the tasks and does not download RustDesk or prompt.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$DryRun,
  [switch]$RustDesk,
  [string]$RustDeskPassword
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

& (Join-Path $PSScriptRoot "register-update-tasks.ps1") -RepoRoot $RepoRoot

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

Write-Host ""
Write-Host "Automatic updates are registered."
Write-Host "At sign-in the PC checks GitHub main before the server starts. Nightly default is 3:17 AM local (config.json updates.nightlyAt)."
Write-Host "A failed update rolls back. Scores, photos, and settings in ProgramData are not deleted."
Write-Host "Restart so the wall comes back fullscreen:"
Write-Host "  shutdown /r /t 0"
