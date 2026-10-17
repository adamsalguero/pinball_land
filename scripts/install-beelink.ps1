#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot Beelink install: Node if needed, npm ci, logon tasks, firewall, start the server.
.DESCRIPTION
  Sets the network profile to Private, opens TCP 3000 and 3443 on that profile, and turns off
  AC sleep, monitor timeout, and hibernate. Pass -AutoLogonUser Admin for a passwordless account.
  -DryRun skips Node install, npm ci, AutoAdminLogon, and starting the server.
.PARAMETER AutoLogonUser
  Local passwordless account to sign in automatically, for example Admin.
.PARAMETER DryRun
  Run the Windows setup and print the verify summary without installing packages or starting the server.
#>
param(
  [string]$AutoLogonUser,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

if ($DryRun) {
  Write-Host "Dry run: not installing Node, not running npm ci, not starting the server."
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "Node.js is not on PATH. The Electron check needs node_modules from npm ci."
  }
} else {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is not installed. Installing the LTS with winget..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    Refresh-Path
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is still not on PATH. Install the LTS for all users from https://nodejs.org, open a new PowerShell, and run this script again."
  }

  Write-Host "Installing Pinball Land in $RepoRoot"
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
}

$kioskScript = Join-Path $PSScriptRoot "install-kiosk-windows.ps1"
$configure = @{
  RepoRoot = $RepoRoot
  NoSummary = $true
}
if ($DryRun) { $configure.DryRun = $true }
if ($AutoLogonUser) { $configure.AutoLogonUser = $AutoLogonUser }
& $kioskScript @configure

if (-not $DryRun) {
  Write-Host "Starting the server..."
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { $nodeExe = "node.exe" }
  Start-Process -FilePath $nodeExe -ArgumentList "src/server.js" -WorkingDirectory $RepoRoot -WindowStyle Minimized
  Start-Sleep -Seconds 2
  node -e "const os=require('os'); const nets=os.networkInterfaces(); let ip='localhost'; for (const name of Object.keys(nets)) { for (const net of nets[name]||[]) { if ((net.family==='IPv4'||net.family===4) && !net.internal) ip=net.address; } } console.log(''); console.log('Guest app:  http://'+ip+':3000/'); console.log('Admin app:  http://'+ip+':3000/admin'); console.log('Admin PIN:  2224'); console.log(''); console.log('On the iPhone or iPad: Safari, Share, Add to Home Screen. Do that once for each URL.');"
  Write-Host "BIOS Auto Power On and the BenQ Switch on state are still by hand (see KIOSK.md)."
  if (-not $AutoLogonUser) {
    Write-Host "Auto-logon was not set. For a passwordless account, re-run with -AutoLogonUser Admin."
  }
} else {
  Write-Host "Dry run: server was not started."
}

$verify = @{
  RepoRoot = $RepoRoot
  Verify = $true
}
if ($DryRun) { $verify.DryRun = $true }
if ($AutoLogonUser) { $verify.AutoLogonUser = $AutoLogonUser }
& $kioskScript @verify
