#Requires -Version 5.1
<#
.SYNOPSIS
  Registers Pinball Land kiosk auto-start on Windows 11 (Task Scheduler at logon).
.DESCRIPTION
  Re-runnable. Does not change BIOS.
  Registry tweaks are idempotent and non-critical: a failed notification, screensaver,
  or active-hours write is a warning and does not stop firewall, power, or startup.
  -AutoLogonUser sets AutoAdminLogon for a local passwordless account (for example Admin).
  -DryRun applies the same machine setup except AutoAdminLogon, and is what CI runs.
.PARAMETER AutoLogonUser
  Local passwordless account to sign in automatically, for example Admin.
.PARAMETER DryRun
  Skip AutoAdminLogon. Still registers tasks, power, firewall, and the private network profile.
.PARAMETER Verify
  Print the verify summary and exit. Does not change the machine.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [switch]$Verify,
  [switch]$DryRun,
  [switch]$NoSummary,
  [string]$AutoLogonUser
)

$ErrorActionPreference = "Stop"
$taskName = "PinballLandKiosk"
$serverTask = "PinballLandServer"
$httpRule = "Pinball Land HTTP"
$shareRule = "Pinball Land share"
$plugRule = "Pinball Land plug discovery"
$httpPort = 3000
$sharePort = 3443

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

function Test-PinballUsersModify {
  param([Parameter(Mandatory = $true)][string]$Dir)
  if (-not (Test-Path -LiteralPath $Dir)) { return $false }
  $listing = & icacls.exe $Dir | Out-String
  return $listing -match '(?i)(?:BUILTIN\\)?Users:\(OI\)\(CI\)[^\r\n]*\bM\b'
}

function Grant-PinballDataUsersModify {
  $dir = Get-PinballDataDir
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
  if (Test-PinballUsersModify -Dir $dir) {
    Write-Host "Users already have Modify on $dir."
    return
  }
  Write-Host "Granting Users Modify on $dir..."
  $grant = & icacls.exe $dir /grant "Users:(OI)(CI)M" /T /C | Out-String
  if (-not (Test-PinballUsersModify -Dir $dir)) {
    throw "Users Modify was not present on $dir after icacls (exit $LASTEXITCODE). $grant"
  }
  Write-Host "Users can modify $dir."
}

function Test-KioskAdmin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-KioskRegistryKey {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (Test-Path -LiteralPath $Path) { return }
  $parent = Split-Path -Parent $Path
  if ($parent -and $parent -notmatch '^[A-Za-z]+:\\?$' -and -not (Test-Path -LiteralPath $parent)) {
    Ensure-KioskRegistryKey -Path $parent
  }
  if (-not (Test-Path -LiteralPath $Path)) {
    # Never -Force. -Force deletes the key first, and that throws
    # "Cannot delete a subkey tree because the subkey does not exist"
    # when the key (or one of its children) is already gone.
    New-Item -Path $Path -ErrorAction Stop | Out-Null
  }
}

function Set-KioskRegistryValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Value
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    Ensure-KioskRegistryKey -Path $Path
  }
  Set-ItemProperty -LiteralPath $Path -Name $Name -Value $Value -ErrorAction Stop
}

function Try-KioskRegistryValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Value
  )
  try {
    Set-KioskRegistryValue -Path $Path -Name $Name -Value $Value
  } catch {
    Write-Warning "Skipped registry tweak $Path ($Name): $($_.Exception.Message)"
  }
}

function Invoke-RegistrySelfTest {
  $root = "HKCU:\Software\PinballLandInstallerTest"
  $path = "HKCU:\Software\PinballLandInstallerTest\MissingChild"
  try {
    if (Test-Path -LiteralPath $root) {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
    Set-KioskRegistryValue -Path $path -Name "Probe" -Value 1
    $read = (Get-ItemProperty -LiteralPath $path -Name "Probe" -ErrorAction Stop).Probe
    if ([int]$read -ne 1) { throw "Registry self-test read back '$read'." }
    Set-KioskRegistryValue -Path $path -Name "Probe" -Value 2
    $read = (Get-ItemProperty -LiteralPath $path -Name "Probe" -ErrorAction Stop).Probe
    if ([int]$read -ne 2) { throw "Registry self-test update read back '$read'." }
    Write-Host "Registry writes are idempotent (missing key created, then updated)."
  } finally {
    if (Test-Path -LiteralPath $root) {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Install-ElectronIfMissing {
  $exe = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
  if (Test-Path -LiteralPath $exe) {
    Write-Host "Electron binary present: $exe"
    return
  }
  $installJs = Join-Path $RepoRoot "node_modules\electron\install.js"
  if (-not (Test-Path -LiteralPath $installJs)) {
    Write-Warning "Electron package is missing ($installJs). Run npm ci in $RepoRoot."
    return
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Warning "node is not on PATH, so the Electron binary was not downloaded."
    return
  }
  Write-Host "Electron dist is missing. Running: node node_modules/electron/install.js"
  Push-Location $RepoRoot
  try {
    & node "node_modules/electron/install.js"
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "node node_modules/electron/install.js exited $LASTEXITCODE."
    }
  } catch {
    Write-Warning "Could not run electron install.js: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
  if (Test-Path -LiteralPath $exe) {
    Write-Host "Electron binary present: $exe"
  } else {
    Write-Warning "Electron binary still missing: $exe"
  }
}

function Invoke-KioskPowerCfg {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & powercfg.exe @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "powercfg $($Arguments -join ' ') exited $LASTEXITCODE."
  }
}

function Set-KioskPowerPlan {
  Invoke-KioskPowerCfg -Arguments @("/change", "standby-timeout-ac", "0")
  Invoke-KioskPowerCfg -Arguments @("/change", "monitor-timeout-ac", "0")
  Invoke-KioskPowerCfg -Arguments @("/change", "hibernate-timeout-ac", "0")
  Invoke-KioskPowerCfg -Arguments @("/SETACVALUEINDEX", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE", "0")
  Invoke-KioskPowerCfg -Arguments @("/SETACVALUEINDEX", "SCHEME_CURRENT", "SUB_VIDEO", "VIDEOIDLE", "0")
  Invoke-KioskPowerCfg -Arguments @("/SETACVALUEINDEX", "SCHEME_CURRENT", "SUB_SLEEP", "HIBERNATEIDLE", "0")
  Invoke-KioskPowerCfg -Arguments @("/SETACTIVE", "SCHEME_CURRENT")
}

function Set-KioskPrivateNetwork {
  $profiles = @(Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_ })
  if ($profiles.Count -eq 0) {
    throw "No network connection profile was found."
  }
  foreach ($profile in $profiles) {
    $label = "$($profile.InterfaceAlias) ($($profile.Name))"
    if ([string]$profile.NetworkCategory -eq "Private") {
      Write-Host "Network $label is already Private."
      continue
    }
    Write-Host "Setting network $label from $($profile.NetworkCategory) to Private..."
    try {
      Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
    } catch {
      Write-Warning "Could not set $label to Private: $($_.Exception.Message)"
    }
  }
}

function Add-KioskFirewallRule {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$Port
  )
  & netsh.exe advfirewall firewall delete rule "name=$Name" | Out-Null
  $added = & netsh.exe advfirewall firewall add rule "name=$Name" dir=in action=allow protocol=TCP "localport=$Port" profile=private | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "Could not add firewall rule '$Name' for TCP $Port (netsh exit $LASTEXITCODE). $added"
  }
  Write-Host "Firewall rule '$Name' allows TCP $Port on private networks."
}

function Add-KioskPlugDiscoveryRule {
  $node = Resolve-NodeExe
  & netsh.exe advfirewall firewall delete rule "name=$plugRule" | Out-Null
  if (-not $node) {
    Write-Warning "node.exe was not found, so '$plugRule' was not added."
    return
  }
  $added = & netsh.exe advfirewall firewall add rule "name=$plugRule" dir=in action=allow program="$node" protocol=UDP profile=private,public enable=yes | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "Could not add firewall rule '$plugRule' for node.exe inbound UDP (netsh exit $LASTEXITCODE). $added"
  }
  Write-Host "Firewall rule '$plugRule' allows node.exe inbound UDP on Private and Public networks."
}

function Set-KioskAutoLogon {
  param([Parameter(Mandatory = $true)][string]$User)
  # Blank-password auto-logon needs the password value to exist (even when empty).
  # Windows 11 ignores that while PasswordLess DevicePasswordLessBuildVersion is non-zero.
  $winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  Set-KioskRegistryValue -Path $winlogon -Name "AutoAdminLogon" -Value "1"
  Set-KioskRegistryValue -Path $winlogon -Name "DefaultUserName" -Value $User
  Set-KioskRegistryValue -Path $winlogon -Name "DefaultDomainName" -Value $env:COMPUTERNAME
  Set-KioskRegistryValue -Path $winlogon -Name "DefaultPassword" -Value ""
  $passwordLess = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device"
  Set-KioskRegistryValue -Path $passwordLess -Name "DevicePasswordLessBuildVersion" -Value 0
  Write-Host "AutoAdminLogon set for passwordless local account '$User'."
}

function Get-AcPowerIndex {
  param(
    [Parameter(Mandatory = $true)][string]$Subgroup,
    [Parameter(Mandatory = $true)][string]$Setting
  )
  $output = & powercfg.exe /q SCHEME_CURRENT $Subgroup $Setting | Out-String
  $match = [regex]::Match($output, "Current AC Power Setting Index:\s*0x([0-9A-Fa-f]+)")
  if (-not $match.Success) { return $null }
  return [Convert]::ToInt32($match.Groups[1].Value, 16)
}

function Test-KioskFirewallRule {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$Port
  )
  $output = & netsh.exe advfirewall firewall show rule "name=$Name" | Out-String
  $escaped = [regex]::Escape($Name)
  if ($output -notmatch "Rule Name:\s+$escaped") { return $false }
  if ($output -notmatch "LocalPort:\s+$Port\b") { return $false }
  if ($output -notmatch "Action:\s+Allow") { return $false }
  if ($output -notmatch "Profiles:\s+.*\bPrivate\b") { return $false }
  if ($output -match "Enabled:\s+No") { return $false }
  return $true
}

function Read-KioskRegValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop).$Name
  } catch {
    return $null
  }
}

function Test-TaskWaitsForUpdate {
  param($Task)
  if (-not $Task -or -not $Task.Triggers) { return $false }
  foreach ($trigger in @($Task.Triggers)) {
    $enabled = $true
    if ($null -ne $trigger.Enabled) {
      $raw = "$($trigger.Enabled)"
      if ($raw -eq "False" -or $raw -eq "false") { $enabled = $false }
    }
    $className = [string]$trigger.CimClass.CimClassName
    if ($enabled -and $className -match "Logon") { return $false }
  }
  return $true
}

function Write-KioskVerifySummary {
  param(
    [string]$AutoLogonUser,
    [switch]$DryRun
  )

  $rows = New-Object System.Collections.Generic.List[object]
  function Add-Row {
    param($Label, $State, $Detail)
    $rows.Add([pscustomobject]@{ Label = $Label; State = $State; Detail = $Detail }) | Out-Null
  }

  $kiosk = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $server = Get-ScheduledTask -TaskName $serverTask -ErrorAction SilentlyContinue
  Add-Row "Kiosk task" $(if ($kiosk) { "OK" } else { "FAIL" }) $(if ($kiosk) { $taskName } else { "missing" })
  Add-Row "Server task" $(if ($server) { "OK" } else { "FAIL" }) $(if ($server) { $serverTask } else { "missing" })
  $boot = Get-ScheduledTask -TaskName "PinballLandUpdateBoot" -ErrorAction SilentlyContinue
  $nightly = Get-ScheduledTask -TaskName "PinballLandUpdateNightly" -ErrorAction SilentlyContinue
  $bootArg = ""
  $nightlyArg = ""
  if ($boot -and $boot.Actions) { $bootArg = [string]@($boot.Actions)[0].Arguments }
  if ($nightly -and $nightly.Actions) { $nightlyArg = [string]@($nightly.Actions)[0].Arguments }
  $bootOk = $boot -and $bootArg -match "invoke-update\.ps1" -and $bootArg -match "-Mode boot"
  $nightlyOk = $nightly -and $nightlyArg -match "invoke-update\.ps1" -and $nightlyArg -match "-Mode nightly"
  Add-Row "Update boot task" $(if ($bootOk) { "OK" } else { "FAIL" }) $(if ($bootOk) { "PinballLandUpdateBoot" } else { "missing" })
  Add-Row "Update nightly task" $(if ($nightlyOk) { "OK" } else { "FAIL" }) $(if ($nightlyOk) { "PinballLandUpdateNightly" } else { "missing" })
  $serverWaits = Test-TaskWaitsForUpdate -Task $server
  $kioskWaits = Test-TaskWaitsForUpdate -Task $kiosk
  $orderOk = $serverWaits -and $kioskWaits
  Add-Row "Update before start" $(if ($orderOk) { "OK" } else { "FAIL" }) "server and kiosk start from the boot task"
  $nodePath = $null
  if ($server -and $server.Actions) {
    $nodePath = [string]@($server.Actions)[0].Execute
  }
  $nodeOk = $nodePath -and [System.IO.Path]::IsPathRooted($nodePath) -and $nodePath.ToLower().EndsWith("\node.exe")
  Add-Row "Server node.exe" $(if ($nodeOk) { "OK" } else { "FAIL" }) $(if ($nodePath) { $nodePath } else { "missing" })
  $dataDir = Get-PinballDataDir
  $dataOk = Test-PinballUsersModify -Dir $dataDir
  Add-Row "Data folder" $(if ($dataOk) { "OK" } else { "FAIL" }) $dataDir

  $electronExe = Join-Path $RepoRoot "node_modules\electron\dist\electron.exe"
  $electronPkg = Join-Path $RepoRoot "node_modules\electron"
  if (-not (Test-Path -LiteralPath $electronPkg)) {
    Add-Row "Electron binary" "WARN" "package not installed"
  } elseif (Test-Path -LiteralPath $electronExe) {
    Add-Row "Electron binary" "OK" $electronExe
  } else {
    Add-Row "Electron binary" "FAIL" "missing $electronExe"
  }

  $profiles = @()
  try {
    $profiles = @(Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_ })
  } catch {
    $profiles = @()
  }
  $relevant = New-Object System.Collections.Generic.List[object]
  foreach ($profile in $profiles) {
    $gateway = $null
    try {
      $cfg = Get-NetIPConfiguration -InterfaceIndex $profile.InterfaceIndex -ErrorAction Stop
      $gateway = $cfg.IPv4DefaultGateway
    } catch {
      $gateway = $null
    }
    if ($gateway) { $relevant.Add($profile) | Out-Null }
  }
  if ($relevant.Count -eq 0) {
    foreach ($profile in $profiles) { $relevant.Add($profile) | Out-Null }
  }
  $networkDetail = "no connection profile"
  $networkOk = $false
  if ($relevant.Count -gt 0) {
    $networkOk = $true
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($profile in $relevant) {
      $parts.Add("$($profile.InterfaceAlias)=$($profile.NetworkCategory)") | Out-Null
      if ([string]$profile.NetworkCategory -ne "Private") { $networkOk = $false }
    }
    $networkDetail = $parts -join ", "
  }
  Add-Row "Network profile" $(if ($networkOk) { "OK" } else { "FAIL" }) $networkDetail

  $httpOk = Test-KioskFirewallRule -Name $httpRule -Port $httpPort
  $shareOk = Test-KioskFirewallRule -Name $shareRule -Port $sharePort
  Add-Row "Firewall $httpPort" $(if ($httpOk) { "OK" } else { "FAIL" }) $httpRule
  Add-Row "Firewall $sharePort" $(if ($shareOk) { "OK" } else { "FAIL" }) $shareRule
  $plugOutput = & netsh.exe advfirewall firewall show rule "name=$plugRule" | Out-String
  $plugOk = $plugOutput -match "Rule Name:\s+Pinball Land plug discovery" -and $plugOutput -match "Protocol:\s+UDP" -and $plugOutput -match "Action:\s+Allow" -and $plugOutput -match "Profiles:\s+.*\bPrivate\b" -and $plugOutput -match "Profiles:\s+.*\bPublic\b" -and $plugOutput -notmatch "Enabled:\s+No"
  Add-Row "Firewall plug discovery" $(if ($plugOk) { "OK" } else { "FAIL" }) $plugRule

  $sleep = Get-AcPowerIndex -Subgroup SUB_SLEEP -Setting STANDBYIDLE
  $monitor = Get-AcPowerIndex -Subgroup SUB_VIDEO -Setting VIDEOIDLE
  $hibernate = Get-AcPowerIndex -Subgroup SUB_SLEEP -Setting HIBERNATEIDLE
  $hibernateOk = ($hibernate -eq 0)
  $hibernateDetail = $(if ($null -eq $hibernate) { "unreadable" } else { "$hibernate" })
  if (-not $hibernateOk) {
    $sleepStates = & powercfg.exe /a | Out-String
    if ($sleepStates -match "Hibernation has not been enabled") {
      $hibernateOk = $true
      $hibernateDetail = "hibernation is not enabled"
    }
  }
  Add-Row "AC sleep timeout" $(if ($sleep -eq 0) { "OK" } else { "FAIL" }) $(if ($null -eq $sleep) { "unreadable" } else { "$sleep" })
  Add-Row "AC monitor timeout" $(if ($monitor -eq 0) { "OK" } else { "FAIL" }) $(if ($null -eq $monitor) { "unreadable" } else { "$monitor" })
  Add-Row "AC hibernate timeout" $(if ($hibernateOk) { "OK" } else { "FAIL" }) $hibernateDetail

  $toast = Read-KioskRegValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications" -Name "ToastEnabled"
  $saver = Read-KioskRegValue -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveActive"
  $hoursStart = Read-KioskRegValue -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursStart"
  $hoursEnd = Read-KioskRegValue -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursEnd"
  Add-Row "Toast notifications" $(if ($toast -eq 0) { "OK" } else { "WARN" }) $(if ($null -eq $toast) { "not set" } else { "ToastEnabled=$toast" })
  Add-Row "Screensaver" $(if ("$saver" -eq "0") { "OK" } else { "WARN" }) $(if ($null -eq $saver) { "not set" } else { "ScreenSaveActive=$saver" })
  $hoursOk = ($hoursStart -eq 9 -and $hoursEnd -eq 23)
  Add-Row "Update active hours" $(if ($hoursOk) { "OK" } else { "WARN" }) $(if ($null -eq $hoursStart) { "not set" } else { "$hoursStart-$hoursEnd" })

  if ($AutoLogonUser -and $DryRun) {
    Add-Row "AutoAdminLogon" "SKIP" "dry run, not written for $AutoLogonUser"
  } elseif ($AutoLogonUser) {
    $auto = Read-KioskRegValue -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name "AutoAdminLogon"
    $autoUser = Read-KioskRegValue -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name "DefaultUserName"
    $autoPass = Read-KioskRegValue -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name "DefaultPassword"
    $passwordLess = Read-KioskRegValue -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" -Name "DevicePasswordLessBuildVersion"
    $passwordLessSet = ($null -ne $passwordLess -and "$passwordLess" -eq "0")
    $autoOk = ("$auto" -eq "1" -and "$autoUser" -eq $AutoLogonUser -and $null -ne $autoPass -and $passwordLessSet)
    Add-Row "AutoAdminLogon" $(if ($autoOk) { "OK" } else { "FAIL" }) $AutoLogonUser
  } else {
    Add-Row "AutoAdminLogon" "SKIP" "not requested"
  }

  Write-Host ""
  Write-Host "Verify"
  $failed = $false
  foreach ($row in $rows) {
    if ($row.State -eq "FAIL") { $failed = $true }
    $line = "  {0,-24} {1}" -f $row.Label, $row.State
    if ($row.Detail) { $line = "$line  $($row.Detail)" }
    Write-Host $line
  }
  Write-Host ""
  return -not $failed
}

if ($Verify) {
  $passed = Write-KioskVerifySummary -AutoLogonUser $AutoLogonUser -DryRun:$DryRun
  if ($passed) {
    Write-Host "Verify passed."
    exit 0
  }
  Write-Host "Verify failed."
  exit 1
}

$cmdPath = Join-Path $RepoRoot "scripts\start-kiosk.cmd"
if (-not (Test-Path -LiteralPath $cmdPath)) {
  throw "Missing $cmdPath"
}

if ($DryRun) {
  Write-Host "Dry run: AutoAdminLogon will not be written."
}
if (-not (Test-KioskAdmin)) {
  Write-Warning "This PowerShell is not elevated. Firewall, power, private network, and auto-logon need Administrator."
}

Write-Host "Repo: $RepoRoot"
try {
  Invoke-RegistrySelfTest
} catch {
  Write-Warning "Registry self-test failed: $($_.Exception.Message)"
  if ($DryRun) { throw }
}

Install-ElectronIfMissing

Write-Host "Letting Users modify the Pinball Land data folder..."
try {
  Grant-PinballDataUsersModify
} catch {
  Write-Warning "Data folder permissions were not updated: $($_.Exception.Message)"
}

Write-Host "Registering scheduled task '$taskName' to run at logon..."
try {
  $action = New-ScheduledTaskAction -Execute $cmdPath -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $trigger.Delay = "PT20S"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

  $nodeExe = Resolve-NodeExe
  if (-not $nodeExe) {
    Write-Warning "node.exe was not found on PATH. The server task was not registered."
  } else {
    $serverAction = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$RepoRoot\src\server.js`"" -WorkingDirectory $RepoRoot
    $serverTrigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $serverTask -Action $serverAction -Trigger $serverTrigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Registered '$serverTask' with $nodeExe. The boot update task starts it after the update check."
  }
} catch {
  Write-Warning "Scheduled tasks were not registered: $($_.Exception.Message)"
}

Write-Host "Registering boot and nightly update tasks..."
try {
  & (Join-Path $PSScriptRoot "register-update-tasks.ps1") -RepoRoot $RepoRoot
} catch {
  Write-Warning "Update tasks were not registered: $($_.Exception.Message)"
}

Write-Host "Hiding notifications, the screensaver, and update reboots during open hours..."
Try-KioskRegistryValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications" -Name "ToastEnabled" -Value 0
Try-KioskRegistryValue -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveActive" -Value "0"
# Active hours: Windows Update should not reboot while the venue is open. Adjust in Settings if close time changes.
Try-KioskRegistryValue -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursStart" -Value 9
Try-KioskRegistryValue -Path "HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" -Name "ActiveHoursEnd" -Value 23

Write-Host "Setting AC power: never sleep, never turn off the display, never hibernate..."
try {
  Set-KioskPowerPlan
} catch {
  Write-Warning "Power settings were not fully applied: $($_.Exception.Message)"
}

Write-Host "Setting the network profile to Private..."
try {
  Set-KioskPrivateNetwork
} catch {
  Write-Warning "Network profile was not changed: $($_.Exception.Message)"
}

Write-Host "Allowing the guest and admin apps through the private-network firewall..."
foreach ($rule in @(
    @{ Name = $httpRule; Port = $httpPort },
    @{ Name = $shareRule; Port = $sharePort }
  )) {
  try {
    Add-KioskFirewallRule -Name $rule.Name -Port $rule.Port
  } catch {
    Write-Warning "Firewall rule was not added: $($_.Exception.Message)"
  }
}
try {
  Add-KioskPlugDiscoveryRule
} catch {
  Write-Warning "Plug discovery firewall rule was not added: $($_.Exception.Message)"
}

if ($AutoLogonUser -and $DryRun) {
  Write-Host "Dry run: would set AutoAdminLogon for passwordless account '$AutoLogonUser'."
} elseif ($AutoLogonUser) {
  try {
    Set-KioskAutoLogon -User $AutoLogonUser
  } catch {
    Write-Warning "AutoAdminLogon was not set for '$AutoLogonUser': $($_.Exception.Message)"
  }
}

if (-not $NoSummary) {
  Write-Host ""
  Write-Host "Done. Still by hand:"
  Write-Host "  1. BIOS Auto Power On after AC restore (see KIOSK.md)."
  Write-Host "  2. BenQ OSD: System -> Switch on state = On."
  if (-not $AutoLogonUser) {
    Write-Host "  3. Auto-logon: re-run with -AutoLogonUser Admin for a passwordless account, or use netplwiz."
  }
  Write-Host "  Sign out and back in, or run scripts\start-kiosk.cmd to test now."
  Write-Host ""
  Write-Host "Uninstall later with:  powershell -File scripts\uninstall-kiosk-windows.ps1"
  $passed = Write-KioskVerifySummary -AutoLogonUser $AutoLogonUser -DryRun:$DryRun
  if ($passed) {
    Write-Host "Verify passed."
  } else {
    Write-Host "Verify failed."
    exit 1
  }
}
