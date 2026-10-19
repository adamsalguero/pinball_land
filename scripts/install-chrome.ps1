#Requires -Version 5.1
<#
.SYNOPSIS
  Find or install Google Chrome for the wall.
.DESCRIPTION
  Dot-source this file. Find-PinballChrome looks in Program Files and the
  per-user install. Install-PinballChrome uses winget (Google.Chrome), then
  the enterprise MSI. -DryRun does not download.
#>

function Find-PinballChrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  )
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

function Install-PinballChrome {
  param([switch]$DryRun)
  $found = Find-PinballChrome
  if ($found) {
    Write-Host "Google Chrome is already installed: $found"
    return $found
  }
  if ($DryRun) {
    Write-Host "Dry run: would install Google Chrome with winget (Google.Chrome), then the enterprise MSI."
    return $null
  }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host "Installing Google Chrome (winget Google.Chrome)..."
    & winget install --id Google.Chrome -e --accept-package-agreements --accept-source-agreements
    $found = Find-PinballChrome
    if ($found) {
      Write-Host "Google Chrome is at $found"
      return $found
    }
    Write-Warning "winget did not leave chrome.exe in a known location. Trying the enterprise MSI."
  } else {
    Write-Warning "winget was not found. Trying the Chrome enterprise MSI."
  }
  $msi = Join-Path $env:TEMP "GoogleChromeStandaloneEnterprise64.msi"
  $msiUrl = "https://dl.google.com/chrome/install/GoogleChromeStandaloneEnterprise64.msi"
  Write-Host "Downloading $msiUrl"
  Invoke-WebRequest -Uri $msiUrl -OutFile $msi -UseBasicParsing
  $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $msi, "/qn", "/norestart") -Wait -PassThru
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
    Write-Warning "Chrome MSI exited $($proc.ExitCode)."
  }
  $found = Find-PinballChrome
  if ($found) {
    Write-Host "Google Chrome is at $found"
  } else {
    Write-Warning "Google Chrome was not found after install. The wall will try Microsoft Edge, then Electron."
  }
  return $found
}
