const fs = require("fs");
const path = require("path");

function resolveAirplayCommand({
  command = "",
  root,
  exists = fs.existsSync,
  platform = process.platform,
} = {}) {
  const configured = String(command || "").trim();
  if (configured) {
    const looksPath = path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\");
    if (looksPath && !exists(configured)) {
      return {
        ok: false,
        error: `AirPlay helper not found at ${configured}. See PRESENTING.md.`,
      };
    }
    return { ok: true, command: configured, source: "config" };
  }

  const names = platform === "win32" ? ["uxplay.exe", "UxPlay.exe"] : ["uxplay"];
  const candidates = [];
  for (const name of names) {
    candidates.push(path.join(root, "tools", name));
    candidates.push(path.join(root, "tools", "uxplay", name));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return { ok: true, command: candidate, source: "tools" };
  }
  return {
    ok: false,
    error:
      "UxPlay is not installed. Put uxplay.exe in tools\\ or set airplay.command in config.json. AirServer is the paid alternative. See PRESENTING.md.",
  };
}

function buildAirplayArgs({ windowTitle, bounds, extraArgs = [], platform = process.platform } = {}) {
  const args = ["-n", windowTitle || "Pinball Land", "-nh"];
  const width = Math.round(Number(bounds?.width) || 0);
  const height = Math.round(Number(bounds?.height) || 0);
  if (width > 0 && height > 0) {
    args.push("-s", `${width}x${height}`);
  }
  if (platform === "win32") {
    args.push("-vs", "d3d11videosink");
  }
  for (const extra of extraArgs) {
    if (typeof extra === "string" && extra) args.push(extra);
  }
  return args;
}

function buildPlacementScript({ pid, bounds } = {}) {
  const x = Math.round(Number(bounds?.x) || 0);
  const y = Math.round(Number(bounds?.y) || 0);
  const w = Math.round(Number(bounds?.width) || 0);
  const h = Math.round(Number(bounds?.height) || 0);
  const processId = Number.parseInt(pid, 10);
  if (!Number.isInteger(processId) || processId <= 0 || w <= 0 || h <= 0) {
    return "Write-Output 'WAITING'\n";
  }
  return `
$target = ${processId}
$x = ${x}; $y = ${y}; $w = ${w}; $h = ${h}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PinballPlace {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$script:ids = New-Object System.Collections.Generic.HashSet[int]
[void]$script:ids.Add($target)
Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $target } | ForEach-Object { [void]$script:ids.Add([int]$_.ProcessId) }
$script:best = [IntPtr]::Zero
$script:bestArea = 0
$callback = [PinballPlace+EnumProc]{
  param($hwnd, $lparam)
  $procId = [uint32]0
  [void][PinballPlace]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  if (-not $script:ids.Contains([int]$procId)) { return $true }
  if (-not [PinballPlace]::IsWindowVisible($hwnd)) { return $true }
  $rect = New-Object PinballPlace+RECT
  [void][PinballPlace]::GetWindowRect($hwnd, [ref]$rect)
  $area = [Math]::Max(0, $rect.Right - $rect.Left) * [Math]::Max(0, $rect.Bottom - $rect.Top)
  if ($area -gt $script:bestArea) { $script:best = $hwnd; $script:bestArea = $area }
  return $true
}
[void][PinballPlace]::EnumWindows($callback, [IntPtr]::Zero)
if ($script:best -eq [IntPtr]::Zero -or $script:bestArea -lt 20000) { Write-Output 'WAITING'; exit 0 }
$GWL_STYLE = -16
$style = [PinballPlace]::GetWindowLong($script:best, $GWL_STYLE)
$style = $style -band (-bnot 0x00C00000) -band (-bnot 0x00040000) -band (-bnot 0x00800000)
$style = $style -bor 0x80000000
[void][PinballPlace]::SetWindowLong($script:best, $GWL_STYLE, $style)
$HWND_TOPMOST = [IntPtr](-1)
$flags = 0x0040 -bor 0x0020
[void][PinballPlace]::SetWindowPos($script:best, $HWND_TOPMOST, $x, $y, $w, $h, $flags)
Write-Output 'PLACED'
`.trim();
}

class AirplayController {
  constructor({
    spawnImpl,
    platform = process.platform,
    root,
    getAirplayConfig = () => ({}),
    exists = fs.existsSync,
    onExit = null,
  } = {}) {
    if (!spawnImpl) throw new Error("spawnImpl is required");
    this.spawn = spawnImpl;
    this.platform = platform;
    this.root = root;
    this.getAirplayConfig = getAirplayConfig;
    this.exists = exists;
    this.onExit = onExit;
    this.child = null;
    this.slot = null;
  }

  start({ slot, bounds } = {}) {
    this.stop();
    const airplay = this.getAirplayConfig() || {};
    const resolved = resolveAirplayCommand({
      command: airplay.command,
      root: this.root,
      exists: this.exists,
      platform: this.platform,
    });
    if (!resolved.ok) return resolved;
    const args = buildAirplayArgs({
      windowTitle: airplay.windowTitle,
      bounds,
      extraArgs: airplay.args,
      platform: this.platform,
    });
    let child;
    try {
      child = this.spawn(resolved.command, args, {
        stdio: "ignore",
        windowsHide: false,
      });
    } catch (err) {
      return { ok: false, error: err.message || "Could not start UxPlay" };
    }
    this.child = child;
    this.slot = String(slot);
    const noteExit = (message) => {
      if (this.child !== child) return;
      this.child = null;
      const exitedSlot = this.slot;
      this.slot = null;
      if (this.onExit && exitedSlot) this.onExit(exitedSlot, message);
    };
    if (child && typeof child.on === "function") {
      child.on("error", (err) => noteExit(err.message || "UxPlay failed to start"));
      child.on("exit", (code) => noteExit(`UxPlay exited (${code})`));
    }
    return { ok: true, pid: child?.pid || null, command: resolved.command };
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.slot = null;
    if (!child) return;
    if (this.platform === "win32" && child.pid) {
      try {
        this.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        if (typeof child.kill === "function") child.kill();
      }
      return;
    }
    if (typeof child.kill === "function") child.kill();
  }

  ready() {
    const airplay = this.getAirplayConfig() || {};
    return resolveAirplayCommand({
      command: airplay.command,
      root: this.root,
      exists: this.exists,
      platform: this.platform,
    });
  }
}

module.exports = {
  resolveAirplayCommand,
  buildAirplayArgs,
  buildPlacementScript,
  AirplayController,
};
