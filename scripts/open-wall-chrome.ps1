param(
  [string]$Base = "http://127.0.0.1:3000"
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
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$chrome = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) { throw "Google Chrome was not found." }

$positions = @(
  @(0, 0),
  @(80, 60),
  @(160, 120)
)
foreach ($slot in 1, 2, 3) {
  $pos = $positions[$slot - 1]
  $args = @(
    "--app=$Base/display/$slot",
    "--window-position=$($pos[0]),$($pos[1])",
    "--window-size=1280,720"
  ) + $flags
  Start-Process -FilePath $chrome -ArgumentList $args
}
