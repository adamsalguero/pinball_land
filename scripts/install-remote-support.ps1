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

function Install-RustDeskService {
  param([Parameter(Mandatory = $true)][string]$Password)
  $asset = Get-LatestRustDeskExe
  if ($DryRun) {
    Write-Host "Dry run: would download $($asset.name) and install the RustDesk service."
    return
  }
  $installer = Join-Path $env:TEMP "rustdesk-latest-x86_64.exe"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing
  $install = Start-Process -FilePath $installer -ArgumentList "--silent-install" -Wait -PassThru
  if ($install.ExitCode -ne 0 -and $null -ne $install.ExitCode) {
    throw "RustDesk installer exited $($install.ExitCode)"
  }
  $exe = Join-Path $env:ProgramFiles "RustDesk\rustdesk.exe"
  if (-not (Test-Path -LiteralPath $exe)) {
    throw "RustDesk was not installed at $exe"
  }
  $service = Get-Service -Name "RustDesk" -ErrorAction SilentlyContinue
  if (-not $service) {
    & $exe --install-service | Out-Null
    $service = Get-Service -Name "RustDesk" -ErrorAction SilentlyContinue
  }
  if ($service) {
    Set-Service -Name "RustDesk" -StartupType Automatic
    if ($service.Status -ne "Running") {
      Start-Service -Name "RustDesk"
    }
  } else {
    Write-Warning "The RustDesk service was not found after install. The program is installed; start it from the Start menu once if the ID is blank."
  }
  & $exe --password $Password | Out-Null
  $id = (& $exe --get-id | Out-String).Trim()
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
