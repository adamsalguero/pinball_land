#Requires -Version 5.1
<#
.SYNOPSIS
  Boot, nightly, or manual update. Starts the current server even when GitHub is down.
.DESCRIPTION
  Boot runs before the server and the kiosk. Nightly and Update now stop those tasks,
  update, then start them again so the TVs come back fullscreen. Venue data is not deleted.
#>
param(
  [ValidateSet("boot", "nightly", "now", "retry")]
  [string]$Mode = "boot"
)

$ErrorActionPreference = "Continue"
$ScriptDir = $PSScriptRoot
if ($env:PINBALL_APP_ROOT) {
  $RepoRoot = (Resolve-Path -LiteralPath $env:PINBALL_APP_ROOT).Path
} else {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
# Leave the install directory so a staged swap can rename it.
Set-Location (Split-Path -Parent $RepoRoot)

$serverTask = "PinballLandServer"
$kioskTask = "PinballLandKiosk"

function Get-PinballDataDir {
  if ($env:PINBALL_DATA_DIR) { return $env:PINBALL_DATA_DIR }
  $base = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
  return (Join-Path $base "PinballLand")
}

function Write-UpdateTrace {
  param([string]$Message)
  try {
    $dir = Join-Path (Get-PinballDataDir) "logs"
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir | Out-Null
    }
    $line = "[{0}] invoke {1} {2}" -f (Get-Date).ToUniversalTime().ToString("o"), $Mode, $Message
    Add-Content -LiteralPath (Join-Path $dir "update.log") -Value $line -Encoding UTF8
  } catch {
    Write-Warning "Could not write the update log: $($_.Exception.Message)"
  }
}

function Test-UpdatesEnabled {
  $config = Join-Path (Get-PinballDataDir) "config.json"
  if (-not (Test-Path -LiteralPath $config)) { return $true }
  try {
    $json = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($json.updates -and $json.updates.enabled -eq $false) { return $false }
  } catch {
    return $true
  }
  return $true
}

function Resolve-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and $cmd.Source -match '\.exe$') { return $cmd.Source }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd -or -not $cmd.Source) { return $null }
  if ($cmd.Source -match '\.exe$') { return $cmd.Source }
  $candidate = Join-Path (Split-Path -Parent $cmd.Source) "node.exe"
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return $null
}

function Stop-PinballProcesses {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $cmd = [string]$_.CommandLine
    if (-not $cmd) { return $false }
    if ($cmd -match "run-update\.js" -or $cmd -match "invoke-update\.ps1") { return $false }
    $ours = $cmd -match "pinball-land"
    if (-not $ours) { return $false }
    return ($cmd -match "src\\server\.js" -or $cmd -match "src/server\.js" -or $cmd -match "start-kiosk" -or $cmd -match "kiosk\.js" -or $cmd -match "electron")
  })
  foreach ($proc in $procs) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Stop-PinballTasks {
  foreach ($name in @($kioskTask, $serverTask)) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  }
  Stop-PinballProcesses
}

function Start-PinballTask {
  param([Parameter(Mandatory = $true)][string]$Name)
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-UpdateTrace "scheduled task $Name is not registered"
    Write-Warning "Scheduled task '$Name' is not registered."
    return $false
  }
  if ([string]$task.State -eq "Running") {
    Write-UpdateTrace "$Name already running"
    return $true
  }
  try {
    Start-ScheduledTask -TaskName $Name -ErrorAction Stop
    Write-UpdateTrace "started $Name"
    return $true
  } catch {
    Write-UpdateTrace "Start-ScheduledTask $Name failed: $($_.Exception.Message)"
    Write-Warning "Could not start '$Name': $($_.Exception.Message)"
    return $false
  }
}

function Start-HiddenLauncher {
  param([Parameter(Mandatory = $true)][string]$Kind)
  $vbs = Join-Path $PSScriptRoot "launch-hidden.vbs"
  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  if (-not (Test-Path -LiteralPath $vbs) -or -not (Test-Path -LiteralPath $wscript)) {
    Write-UpdateTrace "hidden launcher missing for $Kind"
    return $false
  }
  Start-Process -FilePath $wscript -ArgumentList @("//B", "//Nologo", $vbs, $Kind) -WindowStyle Hidden
  Write-UpdateTrace "started hidden $Kind"
  return $true
}

function Start-Wall {
  $pause = 5
  if ($env:PINBALL_WALL_PAUSE_SEC -match '^\d+$') { $pause = [int]$env:PINBALL_WALL_PAUSE_SEC }
  Write-UpdateTrace "phase wall-server"
  if (-not (Start-PinballTask -Name $serverTask)) {
    if (-not $env:PINBALL_APP_ROOT) { Start-HiddenLauncher -Kind server | Out-Null }
  }
  if ($pause -gt 0) { Start-Sleep -Seconds $pause }
  Write-UpdateTrace "phase wall-kiosk"
  if (-not (Start-PinballTask -Name $kioskTask)) {
    if (-not $env:PINBALL_APP_ROOT) { Start-HiddenLauncher -Kind kiosk | Out-Null }
  }
}

function Test-GithubDns {
  if ($env:PINBALL_DNS_FILE) {
    return Test-Path -LiteralPath $env:PINBALL_DNS_FILE
  }
  try {
    $answers = [System.Net.Dns]::GetHostAddresses("github.com")
    return ($null -ne $answers) -and (@($answers).Length -gt 0)
  } catch {
    return $false
  }
}

function Wait-ForGithubDns {
  param([int]$TimeoutSec = 120)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ($true) {
    if (Test-GithubDns) {
      Write-UpdateTrace "github.com resolves"
      return $true
    }
    Write-UpdateTrace "waiting for github.com"
    if ((Get-Date) -ge $deadline) {
      Write-UpdateTrace "github.com did not resolve within ${TimeoutSec}s"
      return $false
    }
    $remaining = ($deadline - (Get-Date)).TotalSeconds
    if ($remaining -le 0) {
      Write-UpdateTrace "github.com did not resolve within ${TimeoutSec}s"
      return $false
    }
    Start-Sleep -Seconds ([Math]::Min(5, [Math]::Ceiling($remaining)))
  }
}

function Read-UpdateStatus {
  $file = Join-Path (Get-PinballDataDir) "logs\update-status.json"
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try {
    return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-NetworkSkip {
  param($Status)
  if (-not $Status) { return $false }
  if ([string]$Status.action -ne "skipped") { return $false }
  try {
    $parsed = [datetimeoffset]::Parse([string]$Status.at).UtcDateTime
  } catch {
    return $false
  }
  if (((Get-Date).ToUniversalTime() - $parsed).TotalMinutes -gt 10) { return $false }
  $detail = [string]$Status.detail
  return $detail -match "Could not resolve host" -or $detail -match "unable to access" -or $detail -match "git fetch failed" -or $detail -match "git fetch timed out"
}

function Register-UpdateRetry {
  $taskName = "PinballLandUpdateRetry"
  $when = (Get-Date).AddMinutes(3)
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $wrapper = Join-Path $PSScriptRoot "invoke-update.ps1"
  $action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`" -Mode retry" -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -Once -At $when
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
  $user = $env:USERNAME
  foreach ($level in @("Highest", "Limited")) {
    try {
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $level
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
      Write-UpdateTrace "scheduled retry at $($when.ToUniversalTime().ToString('o'))"
      return
    } catch {
      Write-UpdateTrace "retry schedule ($level) failed: $($_.Exception.Message)"
    }
  }
}

function Remove-TemporaryWallTask {
  $name = "PinballLandWallNow"
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { return }
  try {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
    Write-UpdateTrace "removed PinballLandWallNow"
  } catch {
    Write-UpdateTrace "could not remove PinballLandWallNow: $($_.Exception.Message)"
  }
}

function Register-UpdateNowTask {
  $name = "PinballLandUpdateNow"
  $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($existing) { return }
  $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
  $hidden = Join-Path $PSScriptRoot "launch-hidden.vbs"
  if (-not (Test-Path -LiteralPath $wscript) -or -not (Test-Path -LiteralPath $hidden)) {
    Write-UpdateTrace "could not register $name"
    return
  }
  $action = New-ScheduledTaskAction -Execute $wscript -Argument "//B //Nologo `"$hidden`" now" -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse("2035-01-01T00:00:00"))
  $trigger.Enabled = $false
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $user = $env:USERNAME
  foreach ($level in @("Highest", "Limited")) {
    try {
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $level
      Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
      Write-UpdateTrace "registered $name"
      return
    } catch {
      Write-UpdateTrace "register $name ($level) failed: $($_.Exception.Message)"
    }
  }
}

$skipWall = $false
$skipRestart = $false
$scheduleRetry = $false
try {
# The button looks for this line. Write it before DNS, git, or stopping the wall.
Write-UpdateTrace "start"
if ($env:PINBALL_UPDATE_SMOKE -eq "1") {
  $skipWall = $true
  return
}

$updatesOff = $false
if ($Mode -eq "nightly" -and -not (Test-UpdatesEnabled)) {
  Write-UpdateTrace "skipped because automatic updates are off"
  Write-Host "Automatic updates are off. Nightly restart was not run."
  $updatesOff = $true
}

$incomingMode = $Mode
if ($Mode -eq "retry") {
  if (-not (Wait-ForGithubDns -TimeoutSec 120)) {
    Write-UpdateTrace "retry gave up; github.com still does not resolve"
    return
  }
  $Mode = "now"
}

$dnsTimeout = 120
if ($env:PINBALL_DNS_TIMEOUT_SEC -match '^\d+$') { $dnsTimeout = [int]$env:PINBALL_DNS_TIMEOUT_SEC }
$dnsOk = $true
if ($Mode -eq "boot") {
  Write-UpdateTrace "phase dns-wait"
  $dnsOk = Wait-ForGithubDns -TimeoutSec $dnsTimeout
}

if ($Mode -eq "boot" -or $Mode -eq "nightly") {
  Register-UpdateNowTask
}

$nodeExe = Resolve-NodeExe
$updateJs = Join-Path $ScriptDir "run-update.js"
$checkJs = Join-Path $ScriptDir "check-install.js"
$flag = if ($Mode -eq "nightly") { "--nightly" } elseif ($Mode -eq "now") { "--now" } else { "--boot" }
$plan = 0
if (-not $updatesOff -and $dnsOk -and $nodeExe -and (Test-Path -LiteralPath $updateJs)) {
  Write-UpdateTrace "phase update-plan"
  & $nodeExe $updateJs $flag --status-only
  $plan = $LASTEXITCODE
  if ($plan -eq 10) { Write-UpdateTrace "update available" }
  if ($plan -eq 11) { Write-UpdateTrace "update skipped" }
} elseif ($Mode -eq "boot" -and -not $dnsOk) {
  Write-UpdateTrace "phase update-skip"
  Write-UpdateTrace "network unavailable; skipping the update"
  $env:PINBALL_UPDATE_OFFLINE = "1"
  $scheduleRetry = $true
}

$installHealthy = $true
if (($Mode -eq "nightly" -or $Mode -eq "now") -and $nodeExe -and (Test-Path -LiteralPath $checkJs)) {
  & $nodeExe $checkJs --scan
  if ($LASTEXITCODE -ne 0) {
    $installHealthy = $false
    Write-UpdateTrace "install integrity failed"
  }
}

$apply = ($plan -eq 10) -and -not $updatesOff
if (($Mode -eq "nightly" -or $Mode -eq "now") -and -not $apply -and $installHealthy) {
  Write-UpdateTrace "up-to-date; leaving the wall running"
  $skipRestart = $true
}

if (($Mode -eq "nightly" -or $Mode -eq "now") -and -not $skipRestart) {
  Write-Host "Stopping the server and the kiosk before the update."
  Stop-PinballTasks
}

if ($apply -and -not $skipRestart -and $nodeExe) {
  Write-UpdateTrace "phase update-apply"
  & $nodeExe $updateJs $flag
  if ($LASTEXITCODE -ne 0) {
    Write-UpdateTrace "updater exit $LASTEXITCODE; starting the current version"
    Write-Warning "Updater exited $LASTEXITCODE. Starting the current version."
  }
} elseif (-not $nodeExe -and -not $skipRestart) {
  Write-UpdateTrace "node.exe missing; starting the current tasks"
  Write-Warning "node.exe was not found. Starting the current version."
}

if (-not $skipRestart -and $nodeExe -and (Test-Path -LiteralPath $checkJs)) {
  Write-UpdateTrace "phase integrity"
  & $nodeExe $checkJs --repair
  if ($LASTEXITCODE -ne 0) {
    Write-UpdateTrace "install integrity failed"
    Write-Warning "Install integrity check failed. Starting the current version."
  } else {
    Write-UpdateTrace "install integrity ok"
  }
} elseif ($skipRestart) {
  Write-UpdateTrace "install integrity ok"
}

Remove-TemporaryWallTask

if ($incomingMode -eq "boot" -and ($scheduleRetry -or (Test-NetworkSkip (Read-UpdateStatus)))) {
  Register-UpdateRetry
}

} finally {
  # A flag skips the wall here. Leaving the block directly is a parse error.
  if (-not $skipWall) {
    if ($skipRestart) {
      Write-UpdateTrace "nightly left the wall running"
      Write-Host "Nothing changed. Leaving the wall running."
    } else {
      Write-Host "Starting the server and the kiosk."
    }
    try {
      # Start-Wall leaves a task that is already running alone, so an up-to-date nightly does not bounce the TVs.
      Start-Wall
      Write-UpdateTrace "server and kiosk started"
    } catch {
      Write-UpdateTrace "Start-Wall failed: $($_.Exception.Message)"
      Write-Warning "The wall did not start: $($_.Exception.Message)"
    }
  }
}
exit 0
