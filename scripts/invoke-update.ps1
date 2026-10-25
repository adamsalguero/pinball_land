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
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

$serverTask = "PinballLandServer"
$kioskTask = "PinballLandKiosk"

function Get-PinballDataDir {
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
    Write-Warning "Scheduled task '$Name' is not registered."
    return
  }
  if ([string]$task.State -eq "Running") { return }
  Start-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
}

function Start-Wall {
  Start-PinballTask -Name $serverTask
  Start-Sleep -Seconds 5
  Start-PinballTask -Name $kioskTask
}

function Test-GithubDns {
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

if ($Mode -eq "nightly" -and -not (Test-UpdatesEnabled)) {
  Write-UpdateTrace "skipped because automatic updates are off"
  Write-Host "Automatic updates are off. Nightly restart was not run."
  exit 0
}

$incomingMode = $Mode
if ($Mode -eq "retry") {
  if (-not (Wait-ForGithubDns -TimeoutSec 120)) {
    Write-UpdateTrace "retry gave up; github.com still does not resolve"
    exit 0
  }
  $Mode = "now"
}

if ($Mode -eq "boot") {
  Wait-ForGithubDns -TimeoutSec 120 | Out-Null
}

$nodeExe = Resolve-NodeExe
$updateJs = Join-Path $RepoRoot "scripts\run-update.js"
$flag = if ($Mode -eq "nightly") { "--nightly" } elseif ($Mode -eq "now") { "--now" } else { "--boot" }

Write-UpdateTrace "start"
if ($Mode -eq "nightly" -or $Mode -eq "now") {
  Write-Host "Stopping the server and the kiosk before the update."
  Stop-PinballTasks
}

if (-not $nodeExe) {
  Write-UpdateTrace "node.exe missing; starting the current tasks"
  Write-Warning "node.exe was not found. Starting the current version."
} else {
  & $nodeExe $updateJs $flag
  if ($LASTEXITCODE -ne 0) {
    Write-UpdateTrace "updater exit $LASTEXITCODE; starting the current version"
    Write-Warning "Updater exited $LASTEXITCODE. Starting the current version."
  }
}

if ($incomingMode -eq "boot" -and (Test-NetworkSkip (Read-UpdateStatus))) {
  Register-UpdateRetry
}

Write-Host "Starting the server and the kiosk."
Start-Wall
Write-UpdateTrace "server and kiosk started"
exit 0
