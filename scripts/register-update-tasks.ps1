#Requires -Version 5.1
<#
.SYNOPSIS
  Registers boot and nightly Pinball Land update tasks.
.DESCRIPTION
  The boot task runs at sign-in as the logged-on user (interactive, so the TVs have a desktop)
  and starts the server and kiosk only after the update attempt. The server and kiosk tasks
  stay on demand so they do not race npm ci. Nightly time comes from config.json updates.nightlyAt
  (default 03:17). Re-runnable.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$bootTask = "PinballLandUpdateBoot"
$nightlyTask = "PinballLandUpdateNightly"
$serverTask = "PinballLandServer"
$kioskTask = "PinballLandKiosk"
$nowTask = "PinballLandUpdateNow"

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

function Get-PinballDataDir {
  $base = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
  return (Join-Path $base "PinballLand")
}

function Get-NightlyClock {
  param([string]$Root)
  $fallback = "03:17"
  $candidates = New-Object System.Collections.Generic.List[string]
  $candidates.Add((Join-Path (Get-PinballDataDir) "config.json")) | Out-Null
  $candidates.Add((Join-Path $Root "config.json")) | Out-Null
  foreach ($file in $candidates) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    try {
      $json = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
      $clock = [string]$json.updates.nightlyAt
      if ($clock -match '^\d{1,2}:\d{2}$') { return $clock }
    } catch {
      continue
    }
  }
  return $fallback
}

function New-OnDemandTrigger {
  $trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse("2035-01-01T00:00:00"))
  $trigger.Enabled = $false
  return $trigger
}

function Disable-TaskTriggers {
  param([Parameter(Mandatory = $true)][string]$Name)
  try {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task -or -not $task.Triggers) { return }
    $changed = $false
    foreach ($trigger in @($task.Triggers)) {
      if ($trigger.Enabled -ne $false) {
        $trigger.Enabled = $false
        $changed = $true
      }
    }
    if ($changed) {
      Set-ScheduledTask -InputObject $task | Out-Null
    }
  } catch {
    Write-Warning "Could not disable triggers on ${Name}: $($_.Exception.Message)"
  }
}

function Register-PinballTask {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Action,
    [Parameter(Mandatory = $true)]$Trigger,
    [Parameter(Mandatory = $true)]$Settings,
    [Parameter(Mandatory = $true)][string]$UserId,
    [ValidateSet("Limited", "Highest")]
    [string]$RunLevel = "Limited"
  )
  $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel $RunLevel
  try {
    Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -Principal $principal -Force | Out-Null
  } catch {
    if ($RunLevel -eq "Limited") { throw }
    Write-Warning "Highest run level was not accepted for ${Name}: $($_.Exception.Message)"
    $fallback = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -Principal $fallback -Force | Out-Null
  }
}

$nodeExe = Resolve-NodeExe
if (-not $nodeExe) {
  throw "node.exe was not found on PATH. Update tasks were not registered."
}

$wrapper = Join-Path $PSScriptRoot "invoke-update.ps1"
if (-not (Test-Path -LiteralPath $wrapper)) {
  throw "Missing $wrapper"
}
$kioskCmd = Join-Path $RepoRoot "scripts\start-kiosk.cmd"
if (-not (Test-Path -LiteralPath $kioskCmd)) {
  throw "Missing $kioskCmd"
}
$hidden = Join-Path $PSScriptRoot "launch-hidden.vbs"
if (-not (Test-Path -LiteralPath $hidden)) {
  throw "Missing $hidden"
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$user = $env:USERNAME
$hiddenArgs = "//B //Nologo `"$hidden`""

$serverAction = New-ScheduledTaskAction -Execute $wscript -Argument "$hiddenArgs server" -WorkingDirectory $RepoRoot
$kioskAction = New-ScheduledTaskAction -Execute $wscript -Argument "$hiddenArgs kiosk" -WorkingDirectory $RepoRoot
$bootAction = New-ScheduledTaskAction -Execute $wscript -Argument "$hiddenArgs boot" -WorkingDirectory $RepoRoot
$nightlyAction = New-ScheduledTaskAction -Execute $wscript -Argument "$hiddenArgs nightly" -WorkingDirectory $RepoRoot
$nowAction = New-ScheduledTaskAction -Execute $wscript -Argument "$hiddenArgs now" -WorkingDirectory $RepoRoot

$clock = Get-NightlyClock -Root $RepoRoot
$match = [regex]::Match($clock, '^(\d{1,2}):(\d{2})$')
$hour = 3
$minute = 17
if ($match.Success) {
  $hour = [int]$match.Groups[1].Value
  $minute = [int]$match.Groups[2].Value
}
if ($hour -gt 23 -or $minute -gt 59) {
  $hour = 3
  $minute = 17
}
$nightlyAt = Get-Date -Hour $hour -Minute $minute -Second 0
if ($nightlyAt -le (Get-Date)) {
  $nightlyAt = $nightlyAt.AddDays(1)
}
$nightlyTrigger = New-ScheduledTaskTrigger -Daily -At $nightlyAt
$nightlyTrigger.StartBoundary = $nightlyAt.ToString("yyyy-MM-dd'T'HH':'mm':'ss")
$bootTrigger = New-ScheduledTaskTrigger -AtLogOn

Register-PinballTask -Name $serverTask -Action $serverAction -Trigger (New-OnDemandTrigger) -Settings $settings -UserId $user -RunLevel Limited
Disable-TaskTriggers -Name $serverTask
Register-PinballTask -Name $kioskTask -Action $kioskAction -Trigger (New-OnDemandTrigger) -Settings $settings -UserId $user -RunLevel Limited
Disable-TaskTriggers -Name $kioskTask
Register-PinballTask -Name $bootTask -Action $bootAction -Trigger $bootTrigger -Settings $settings -UserId $user -RunLevel Highest
Register-PinballTask -Name $nightlyTask -Action $nightlyAction -Trigger $nightlyTrigger -Settings $settings -UserId $user -RunLevel Highest
Register-PinballTask -Name $nowTask -Action $nowAction -Trigger (New-OnDemandTrigger) -Settings $settings -UserId $user -RunLevel Highest
Disable-TaskTriggers -Name $nowTask

Write-Host "Registered '$bootTask' at sign-in. It updates, then starts '$serverTask' and '$kioskTask'."
Write-Host "Registered '$nowTask' on demand. Update now starts that task, outside the server process."
Write-Host "Registered '$nightlyTask' daily at $('{0:D2}:{1:D2}' -f $hour, $minute) local. The wall restarts fullscreen only when main changed."
Write-Host "Update tasks run as $user in the signed-in session so the kiosk still has the TV desktop."
