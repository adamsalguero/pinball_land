# Installs the UxPlay Windows build and Apple Bonjour Print Services for the Pinball Land kiosk.
# Run from an elevated PowerShell on the wall PC:
#   powershell -ExecutionPolicy Bypass -File scripts\install-airplay-windows.ps1
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Tools = Join-Path $Root "tools"
$Dest = Join-Path $Tools "uxplay-windows"
$Temp = Join-Path $env:TEMP "pinball-land-airplay"

# leapbtw/uxplay-windows 2.0.0.1736, x64. SHA-256 is the GitHub release asset digest.
# Do not use the ARM64 zip. Upstream FDH2/UxPlay does not publish a Windows exe.
$UxZipUrl = "https://github.com/leapbtw/uxplay-windows/releases/download/2.0.0.1736/uxplay-windows.zip"
$UxZipSha = "9d3a51c15fc9db857351195e7eb7bbb21700d9ae25d936a54bcf8536b62cca18"

# Apple Bonjour Print Services 2.0.2 from download.info.apple.com.
# SHA-256 checked against a direct download of that file (same digest winget publishes).
$BonjourUrl = "https://download.info.apple.com/Mac_OS_X/061-8098.20100603.gthyu/BonjourPSSetup.exe"
$BonjourSha = "7f1ec347cd429cfb25a34b2147e02231334f28290e0c28be213415b0f99da1a0"
$BonjourPage = "https://support.apple.com/en-us/106380"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLower()
}

function Save-Checked([string]$Url, [string]$OutFile, [string]$Expected) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
  $actual = Get-Sha256 $OutFile
  if ($actual -ne $Expected.ToLower()) {
    Remove-Item $OutFile -Force
    throw "Checksum mismatch for $OutFile. Expected $Expected, got $actual."
  }
  Write-Host "Checksum ok ($actual)"
}

New-Item -ItemType Directory -Force -Path $Tools, $Temp | Out-Null

$zip = Join-Path $Temp "uxplay-windows.zip"
Save-Checked $UxZipUrl $zip $UxZipSha
if (Test-Path $Dest) {
  Remove-Item $Dest -Recurse -Force
}
Expand-Archive -Path $zip -DestinationPath $Dest -Force
$exe = Get-ChildItem -Path $Dest -Recurse -Filter "uxplay-windows.exe" | Where-Object { $_.Name -notmatch "beacon|arm64" } | Select-Object -First 1
if (-not $exe) {
  $exe = Get-ChildItem -Path $Dest -Recurse -Filter "uxplay*.exe" | Where-Object { $_.Name -notmatch "beacon|arm64" } | Select-Object -First 1
}
if (-not $exe) {
  throw "The UxPlay zip extracted, but uxplay-windows.exe was not inside $Dest."
}
Write-Host "UxPlay is at $($exe.FullName)"
$bundledMdns = Get-ChildItem -Path $Dest -Recurse -Filter "mDNSResponder.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host "The kiosk starts uxplay-windows.exe. It does not start uxplay-bluetooth-beacon.exe."
Write-Host "The exe is unsigned. If SmartScreen appears, choose More info, then Run anyway."

$argumentLine = '-n "Pinball Land" -nh'
$argumentDirs = @(
  (Join-Path $env:ProgramData "uxplay-windows")
)
if ($env:APPDATA) {
  $argumentDirs += (Join-Path $env:APPDATA "leapbtw\uxplay-windows")
}
foreach ($dir in $argumentDirs) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $argumentFile = Join-Path $dir "arguments.txt"
  $existing = ""
  if (Test-Path -LiteralPath $argumentFile) {
    $existing = Get-Content -LiteralPath $argumentFile -Raw -ErrorAction SilentlyContinue
  }
  $rest = [string]$existing
  $rest = [regex]::Replace($rest, '(^|\s)-n\s+("[^"]*"|''[^'']*''|\S+)', ' ')
  $rest = [regex]::Replace($rest, '(^|\s)-nh\b', ' ')
  $rest = ($rest -replace '\s+', ' ').Trim()
  $body = $argumentLine
  if ($rest) { $body = "$argumentLine $rest" }
  Set-Content -LiteralPath $argumentFile -Value $body -Encoding ASCII
  Write-Host "Wrote $argumentFile"
}
Write-Host "The tray app reads arguments.txt, so the receiver name is Pinball Land without a tray click."

$bonjour = Join-Path $Temp "BonjourPSSetup.exe"
Save-Checked $BonjourUrl $bonjour $BonjourSha
if (Test-Administrator) {
  Write-Host "Installing Bonjour Print Services (quiet)."
  $proc = Start-Process -FilePath $bonjour -ArgumentList "/quiet", "/norestart" -Wait -PassThru
  $bonjourService = Get-Service -Name "Bonjour Service" -ErrorAction SilentlyContinue
  if ($proc.ExitCode -eq 0 -or $proc.ExitCode -eq 3010) {
    Write-Host "Bonjour installer finished (exit $($proc.ExitCode))."
  } elseif ($proc.ExitCode -eq 1603 -and ($bonjourService -or $bundledMdns)) {
    $where = if ($bundledMdns) { $bundledMdns.FullName } else { "Bonjour Service" }
    Write-Host "Bonjour Print Services exited 1603. That is non-fatal. AirPlay uses the bundled mDNSResponder ($where)."
  } elseif ($bonjourService -or $bundledMdns) {
    $where = if ($bundledMdns) { $bundledMdns.FullName } else { "Bonjour Service" }
    Write-Host "Bonjour installer exited $($proc.ExitCode). AirPlay uses the bundled mDNSResponder ($where)."
  } else {
    Write-Warning "Bonjour installer exited $($proc.ExitCode). Neither Bonjour Service nor the bundled mDNSResponder is available. Install Bonjour by hand from $BonjourPage"
  }
} else {
  Write-Warning "Not elevated. UxPlay was unpacked, but Bonjour was not installed."
  if ($bundledMdns) {
    Write-Host "AirPlay can still use the bundled mDNSResponder at $($bundledMdns.FullName)."
  } else {
    Write-Warning "Re-run this script in an Administrator PowerShell, or install Bonjour from $BonjourPage"
  }
}

Write-Host ""
Write-Host "Next:"
Write-Host "  1. Allow uxplay and Node.js on private networks if Windows Firewall asks."
Write-Host "  2. Restart the kiosk (npm run kiosk)."
Write-Host "  3. On the iPad, tap the screen under AirPlay. On the iPhone, Screen Mirroring, then Pinball Land."
Write-Host "AirServer remains the paid fallback. Put its exe path in config.json airplay.command. See PRESENTING.md."
