#Requires -Version 5.1
<#
.SYNOPSIS
  Installs unattended remote support. RustDesk is the default. AnyDesk is optional.
.DESCRIPTION
  RustDesk comes from the latest GitHub x86_64 release, installs as a Windows service,
  and gets a permanent password for this run only. The password is not written into the repo.
  -DryRun does not download or prompt.
#>
param(
  [ValidateSet("rustdesk", "anydesk", "tailscale")]
  [string]$Tool = "rustdesk",
  [string]$RustDeskPassword,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Get-RustDeskPassword {
  if ($RustDeskPassword) { return $RustDeskPassword }
  if ($env:RUSTDESK_PASSWORD) { return $env:RUSTDESK_PASSWORD }
  return $null
}

function Get-LatestRustDeskExe {
  $headers = @{
    "User-Agent" = "pinball-land"
    Accept = "application/vnd.github+json"
  }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/rustdesk/rustdesk/releases/latest" -Headers $headers
  $chosen = $null
  foreach ($asset in @($release.assets)) {
    $name = [string]$asset.name
    if ($name -match '(?i)x86_64\.exe$' -and $name -notmatch '(?i)sciter') {
      $chosen = $asset
      break
    }
  }
  if (-not $chosen) {
    foreach ($asset in @($release.assets)) {
      if ([string]$asset.name -match '(?i)x86_64\.exe$') {
        $chosen = $asset
        break
      }
    }
  }
  if (-not $chosen -or -not $chosen.browser_download_url) {
    throw "The latest RustDesk release has no x86_64 exe."
  }
  return $chosen
}

function Invoke-RustDeskCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$TimeoutSec = 20,
    [switch]$Capture
  )
  # WaitForExit on this PID only. Waiting on the process tree follows the GUI
  # the installer leaves running and never returns.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $quoted = foreach ($arg in $Arguments) {
    if ($arg -match '[\s"]') { '"' + ($arg -replace '"', '\"') + '"' } else { $arg }
  }
  $psi.Arguments = $quoted -join " "
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = [bool]$Capture
  $psi.RedirectStandardError = [bool]$Capture
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    Write-Warning "rustdesk.exe $($Arguments -join ' ') did not exit within ${TimeoutSec}s. Continuing."
    try { $proc.Kill() } catch { }
    return ""
  }
  if (-not $Capture) { return "" }
  return ([string]$proc.StandardOutput.ReadToEnd()).Trim()
}

function Install-RustDeskService {
  param([Parameter(Mandatory = $true)][string]$Password)
  $asset = Get-LatestRustDeskExe
  if ($DryRun) {
    Write-Host "Dry run: would download $($asset.name) and install the RustDesk service."
    return
  }
  $installer = Join-Path $env:TEMP "rustdesk-latest-x86_64.exe"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing
  $exe = Join-Path $env:ProgramFiles "RustDesk\rustdesk.exe"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $installer
  $psi.Arguments = "--silent-install"
  $psi.UseShellExecute = $true
  $install = New-Object System.Diagnostics.Process
  $install.StartInfo = $psi
  [void]$install.Start()
  $deadline = (Get-Date).AddSeconds(120)
  $service = $null
  while ((Get-Date) -lt $deadline) {
    try { $install.Refresh() } catch { }
    $service = Get-Service -Name "RustDesk" -ErrorAction SilentlyContinue
    $exeReady = Test-Path -LiteralPath $exe
    if ($exeReady -and $service) { break }
    $exited = $false
    try { $exited = $install.HasExited } catch { $exited = $true }
    if ($exited) {
      $code = 0
      try { $code = $install.ExitCode } catch { $code = 0 }
      if (-not $exeReady -and $code -ne 0) {
        throw "RustDesk installer exited $code"
      }
      break
    }
    Start-Sleep -Seconds 2
  }
  if (-not (Test-Path -LiteralPath $exe)) {
    throw "RustDesk was not installed at $exe within 120 seconds. The installer was not waited on after that, so the window cannot hang."
  }
  $service = Get-Service -Name "RustDesk" -ErrorAction SilentlyContinue
  if (-not $service) {
    Invoke-RustDeskCommand -Exe $exe -Arguments @("--install-service") -TimeoutSec 30 | Out-Null
    $service = Get-Service -Name "RustDesk" -ErrorAction SilentlyContinue
  }
  if (-not $service) {
    throw "The RustDesk service was not found after install, and rustdesk.exe --install-service did not create it."
  }
  Set-Service -Name "RustDesk" -StartupType Automatic
  $service = Get-Service -Name "RustDesk"
  if ($service.Status -ne "Running") {
    Start-Service -Name "RustDesk"
  }
  Invoke-RustDeskCommand -Exe $exe -Arguments @("--password", $Password) -TimeoutSec 20 | Out-Null
  $id = Invoke-RustDeskCommand -Exe $exe -Arguments @("--get-id") -TimeoutSec 20 -Capture
  Write-Host "RustDesk is installed as a Windows service and starts with Windows."
  Write-Host "RustDesk ID: $id"
}

if ($Tool -eq "rustdesk") {
  $password = Get-RustDeskPassword
  if ($DryRun) {
    Write-Host "Dry run: RustDesk will not be downloaded."
    exit 0
  }
  if (-not $password) {
    throw "Pass -RustDeskPassword or set RUSTDESK_PASSWORD for this run. Do not commit it."
  }
  Install-RustDeskService -Password $password
  exit 0
}

if ($Tool -eq "anydesk") {
  if ($DryRun) {
    Write-Host "Dry run: AnyDesk was not installed."
    exit 0
  }
  if (-not $env:ANYDESK_PASSWORD) { throw "Set ANYDESK_PASSWORD in the environment for this run. Do not commit it." }
  Write-Host "Download AnyDesk from https://anydesk.com and enable Unattended Access with ANYDESK_PASSWORD."
  Write-Host "Do not save that password in this repository."
  exit 0
}

Write-Host "Tailscale: install from https://tailscale.com/download/windows"
Write-Host "Then: tailscale up"
Write-Host "The admin app is https://<tailscale-ip>:3443/admin and SSH/RDP stay on the tailnet."
Write-Host "Tailscale CGNAT addresses (100.64.0.0/10) are treated as local by the kiosk."
