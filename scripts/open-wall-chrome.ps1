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
  "--disable-features=CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo"
)
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
$chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) { throw "Google Chrome was not found." }

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

# One Chrome profile shares a 6-connection HTTP/1.1 pool per host. Each display
# gets its own host so the pools cannot starve each other.
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

$positions = @(
  @(0, 0),
  @(80, 60),
  @(160, 120)
)
foreach ($slot in 1, 2, 3) {
  $pos = $positions[$slot - 1]
  $base = $bases[$slot - 1]
  $args = @(
    "--app=$base/display/$slot",
    "--window-position=$($pos[0]),$($pos[1])",
    "--window-size=1280,720"
  ) + $flags
  Start-Process -FilePath $chrome -ArgumentList $args
}
