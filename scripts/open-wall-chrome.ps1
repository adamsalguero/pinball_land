param(
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$flags = @(
  "--autoplay-policy=no-user-gesture-required",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-background-media-suspend",
  "--force-device-scale-factor=1",
  "--disable-features=CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo",
  "--kiosk",
  "--no-first-run",
  "--no-default-browser-check"
)
$softwareDecode = $false
try {
  $healthUrl = "http://127.0.0.1:$Port/api/health"
  $raw = $null
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $raw = & curl.exe -fsS --max-time 3 $healthUrl
    if ($LASTEXITCODE -ne 0) { $raw = $null }
  }
  if (-not $raw) {
    $raw = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 -Method GET | ConvertTo-Json -Compress -Depth 4
  }
  $health = $raw | ConvertFrom-Json
  if ($health.softwareVideoDecode -eq $true) {
    $softwareDecode = $true
    $flags += "--disable-gpu-video-decode"
    $flags += "--disable-accelerated-video-decode"
  }
} catch {
  # Chrome still launches when health is down or software decode is off.
}
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
if ($env:LOCALAPPDATA) {
  $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
}
$candidates += @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
if ($env:LOCALAPPDATA) {
  $candidates += (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
}
$chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) { throw "Google Chrome and Microsoft Edge were not found." }

function Test-Health([string]$Url) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & curl.exe -fsS -o NUL --max-time 3 $Url
    return $LASTEXITCODE -eq 0
  }
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -Method GET
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

# Each display is its own Chrome process and profile, so one window's compositor
# cannot stall the others. Origins stay split so the HTTP/1.1 pools stay separate.
$third = "http://[::1]:$Port"
if (-not (Test-Health "$third/api/health")) {
  $alt = "http://127.0.0.1:$($Port + 1)"
  if (Test-Health "$alt/api/health") { $third = $alt }
}
$bases = @(
  "http://localhost:$Port",
  "http://127.0.0.1:$Port",
  $third
)

$dataRoot = $env:PINBALL_DATA_DIR
if (-not $dataRoot) { $dataRoot = Join-Path $env:ProgramData "PinballLand" }
$chromeRoot = Join-Path $dataRoot "chrome"
New-Item -ItemType Directory -Force -Path $chromeRoot | Out-Null
$pidFile = Join-Path $chromeRoot "pids.json"

function Stop-OwnedChrome {
  if (-not (Test-Path $pidFile)) { return }
  try { $saved = Get-Content $pidFile -Raw | ConvertFrom-Json } catch { return }
  foreach ($row in @($saved.slots)) {
    if (-not $row.pid) { continue }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($row.pid)" -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $line = [string]$proc.CommandLine
    if ($line -notmatch "chrome\\display[123]") { continue }
    & taskkill.exe /F /T /PID $row.pid | Out-Null
  }
}

Stop-OwnedChrome

$positions = @()
try {
  if (-not ("PinballDpiAware" -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class PinballDpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
  }
  [PinballDpiAware]::SetProcessDPIAware() | Out-Null
  Add-Type -AssemblyName System.Windows.Forms
  $screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }, { $_.Bounds.Y })
  foreach ($screen in $screens) {
    $positions += ,@($screen.Bounds.X, $screen.Bounds.Y, $screen.Bounds.Width, $screen.Bounds.Height)
  }
} catch {
  $positions = @()
}
while ($positions.Count -lt 3) {
  $index = $positions.Count
  $positions += ,@((80 * $index), (60 * $index), 1280, 720)
}

$savedSlots = @()
foreach ($slot in 1, 2, 3) {
  $pos = $positions[$slot - 1]
  $base = $bases[$slot - 1]
  $profile = Join-Path $chromeRoot "display$slot"
  New-Item -ItemType Directory -Force -Path $profile | Out-Null
  $args = @(
    "--user-data-dir=$profile",
    "--app=$base/display/$slot",
    "--window-position=$($pos[0]),$($pos[1])",
    "--window-size=$($pos[2]),$($pos[3])"
  ) + $flags
  $proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
  $savedSlots += [ordered]@{
    slot = $slot
    pid = $proc.Id
    url = "$base/display/$slot"
    x = $pos[0]
    y = $pos[1]
    width = $pos[2]
    height = $pos[3]
  }
}

$record = [ordered]@{
  root = $chromeRoot
  softwareDecode = $softwareDecode
  slots = $savedSlots
}
$record | ConvertTo-Json -Depth 4 | Set-Content -Path $pidFile -Encoding utf8
