#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot Beelink install: Node if needed, npm ci, logon tasks, firewall, start the server.
#>
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

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

& (Join-Path $PSScriptRoot "install-kiosk-windows.ps1") -RepoRoot $RepoRoot

Write-Host "Allowing the guest and admin apps through the private-network firewall..."
netsh advfirewall firewall delete rule name="Pinball Land HTTP" | Out-Null
netsh advfirewall firewall delete rule name="Pinball Land share" | Out-Null
netsh advfirewall firewall add rule name="Pinball Land HTTP" dir=in action=allow protocol=TCP localport=3000 profile=private | Out-Null
netsh advfirewall firewall add rule name="Pinball Land share" dir=in action=allow protocol=TCP localport=3443 profile=private | Out-Null

Write-Host "Starting the server..."
Start-Process -FilePath "node.exe" -ArgumentList "src/server.js" -WorkingDirectory $RepoRoot -WindowStyle Minimized
Start-Sleep -Seconds 2

node -e "const os=require('os'); const nets=os.networkInterfaces(); let ip='localhost'; for (const name of Object.keys(nets)) { for (const net of nets[name]||[]) { if ((net.family==='IPv4'||net.family===4) && !net.internal) ip=net.address; } } console.log(''); console.log('Guest app:  http://'+ip+':3000/'); console.log('Admin app:  http://'+ip+':3000/admin'); console.log('Admin PIN:  2224'); console.log(''); console.log('On the iPhone or iPad: Safari, Share, Add to Home Screen. Do that once for each URL.');"
