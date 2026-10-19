const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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

  const names = platform === "win32"
    ? ["uxplay.exe", "UxPlay.exe", "uxplay-windows.exe"]
    : ["uxplay", "uxplay.exe"];
  const candidates = [];
  for (const name of names) {
    candidates.push(path.join(root, "tools", name));
    candidates.push(path.join(root, "tools", "uxplay", name));
    candidates.push(path.join(root, "tools", "uxplay-windows", name));
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return { ok: true, command: candidate, source: "tools" };
  }
  const nested = findNestedUxplay(path.join(root, "tools", "uxplay-windows"), exists);
  if (nested) return { ok: true, command: nested, source: "tools" };
  return {
    ok: false,
    error:
      "UxPlay is not installed. Run scripts\\install-airplay-windows.ps1, or set airplay.command in config.json. See PRESENTING.md.",
  };
}

function uxplayExeRank(name) {
  const base = path.basename(String(name || "")).toLowerCase();
  if (base === "uxplay-windows.exe") return 0;
  if (base === "uxplay.exe") return 1;
  return 2;
}

function isUxplayExecutable(name) {
  const base = path.basename(String(name || ""));
  if (!/^uxplay.*\.exe$/i.test(base)) return false;
  if (/beacon/i.test(base)) return false;
  if (/arm64/i.test(base)) return false;
  return true;
}

function findNestedUxplay(dir, exists, depth = 0) {
  if (depth > 4 || !exists(dir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = [];
  const dirs = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) dirs.push(full);
    else if (isUxplayExecutable(entry.name) && exists(full)) files.push(full);
  }
  files.sort((a, b) => uxplayExeRank(a) - uxplayExeRank(b) || a.localeCompare(b));
  if (files[0]) return files[0];
  for (const child of dirs) {
    const found = findNestedUxplay(child, exists, depth + 1);
    if (found) return found;
  }
  return null;
}

function uxplayArgumentPaths(env = process.env) {
  const paths = [];
  const programData = env.PROGRAMDATA || "C:\\ProgramData";
  paths.push(path.join(programData, "uxplay-windows", "arguments.txt"));
  if (env.APPDATA) paths.push(path.join(env.APPDATA, "leapbtw", "uxplay-windows", "arguments.txt"));
  return paths;
}

function mergeUxplayArguments(existing, windowTitle = "Pinball Land") {
  const title = String(windowTitle || "Pinball Land").replace(/"/g, "");
  let rest = String(existing || "");
  rest = rest.replace(/(^|\s)-n\s+(?:"[^"]*"|'[^']*'|\S+)/g, " ");
  rest = rest.replace(/(^|\s)-nh\b/g, " ");
  rest = rest.replace(/\s+/g, " ").trim();
  return `-n "${title}" -nh${rest ? ` ${rest}` : ""}`;
}

function writeUxplayArguments({
  windowTitle = "Pinball Land",
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
} = {}) {
  if (platform !== "win32") return [];
  const written = [];
  for (const file of uxplayArgumentPaths(env)) {
    let existing = "";
    try {
      existing = fsImpl.readFileSync(file, "utf8");
    } catch {
      existing = "";
    }
    const body = `${mergeUxplayArguments(existing, windowTitle)}\n`;
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(file, body);
    written.push(file);
  }
  return written;
}

function uxplayImageRunning(image, execImpl = execFileSync) {
  try {
    const out = execImpl("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000,
    });
    const text = String(out || "");
    if (/no tasks are running/i.test(text)) return false;
    return new RegExp(image.replace(".", "\\."), "i").test(text);
  } catch {
    return false;
  }
}

function uxplayAlreadyRunning({ platform = process.platform, execImpl = execFileSync } = {}) {
  if (platform !== "win32" || process.platform !== "win32") return false;
  return uxplayImageRunning("uxplay-windows.exe", execImpl) || uxplayImageRunning("uxplay.exe", execImpl);
}

function uxplayLockPath() {
  return path.join(os.tmpdir(), "pinball-land-uxplay.lock");
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function claimUxplayLaunch({ fsImpl = fs } = {}) {
  if (process.env.NODE_TEST_CONTEXT) return true;
  const lock = uxplayLockPath();
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    const fd = fsImpl.openSync(lock, "wx");
    try {
      fsImpl.writeFileSync(fd, payload);
    } finally {
      fsImpl.closeSync(fd);
    }
    return true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") return true;
  }
  let current = null;
  try {
    current = JSON.parse(fsImpl.readFileSync(lock, "utf8"));
  } catch {
    current = null;
  }
  const at = Number(current && current.at) || 0;
  const age = at ? Date.now() - at : 0;
  const owner = Number(current && current.pid) || 0;
  if (owner && owner !== process.pid && age < 20000 && pidAlive(owner)) return false;
  if (owner && owner !== process.pid && age < 8000) return false;
  try {
    fsImpl.unlinkSync(lock);
  } catch {
    return false;
  }
  return claimUxplayLaunch({ fsImpl });
}

function releaseUxplayLaunch({ fsImpl = fs } = {}) {
  if (process.env.NODE_TEST_CONTEXT) return;
  try {
    fsImpl.writeFileSync(uxplayLockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    // the lock is advisory; a missing file just means the next start rechecks tasklist
  }
}

const AIRPLAY_TARGETS = ["off", "1", "2", "3", "all"];

function normalizeAirplayTarget(value) {
  const target = String(value || "off");
  return AIRPLAY_TARGETS.includes(target) ? target : "off";
}

function interpretAirplayLog(line) {
  const text = String(line || "");
  if (/client disconnected|connection closed|stopped mirroring|mirroring stopped|teardown/i.test(text)) {
    return "end";
  }
  if (/client connected|accepted connection|raop_rtp_mirror|mirror stream|beginning mirroring|mirroring started|connection established/i.test(text)) {
    return "start";
  }
  return null;
}

class AirplaySession {
  constructor({ endAfter = 3 } = {}) {
    this.endAfter = endAfter;
    this.active = false;
    this.seenWaiting = false;
    this.seenPlaced = false;
    this.waitingStreak = 0;
  }

  reset() {
    this.active = false;
    this.seenWaiting = false;
    this.seenPlaced = false;
    this.waitingStreak = 0;
  }

  noteLog(line) {
    const kind = interpretAirplayLog(line);
    if (kind === "start") {
      this.active = true;
      this.waitingStreak = 0;
      return "start";
    }
    if (kind === "end" && this.active) {
      this.active = false;
      this.seenPlaced = false;
      this.waitingStreak = 0;
      return "end";
    }
    return null;
  }

  noteProbe(placed) {
    if (!placed) {
      this.seenWaiting = true;
      if (this.active && this.seenPlaced) {
        this.waitingStreak += 1;
        if (this.waitingStreak >= this.endAfter) {
          this.active = false;
          this.seenPlaced = false;
          this.waitingStreak = 0;
          return "end";
        }
      }
      return null;
    }
    this.waitingStreak = 0;
    this.seenPlaced = true;
    if (!this.seenWaiting || this.active) return null;
    this.active = true;
    return "start";
  }
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
    onSession = null,
    alreadyRunning = null,
  } = {}) {
    if (!spawnImpl) throw new Error("spawnImpl is required");
    this.spawn = spawnImpl;
    this.platform = platform;
    this.root = root;
    this.getAirplayConfig = getAirplayConfig;
    this.exists = exists;
    this.onExit = onExit;
    this.onSession = onSession;
    this.alreadyRunning = alreadyRunning;
    this.child = null;
    this.slot = null;
    this.keepAlive = false;
    this.restarts = 0;
    this.logBuffer = "";
    this.session = new AirplaySession();
  }

  start({ slot, bounds } = {}) {
    this.keepAlive = false;
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
    this.rememberArguments(airplay.windowTitle);
    if (this.externalRunning()) {
      return { ok: true, already: true, external: true, command: resolved.command };
    }
    if (!claimUxplayLaunch()) {
      return { ok: true, already: true, external: true, command: resolved.command };
    }
    let child;
    try {
      if (this.externalRunning()) {
        return { ok: true, already: true, external: true, command: resolved.command };
      }
      child = this.spawn(resolved.command, args, {
        stdio: "ignore",
        windowsHide: false,
      });
    } catch (err) {
      return { ok: false, error: err.message || "Could not start UxPlay" };
    } finally {
      releaseUxplayLaunch();
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

  ensureRunning({ bounds } = {}) {
    this.keepAlive = true;
    if (this.child) {
      return { ok: true, pid: this.child.pid || null, already: true };
    }
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
    return this.launch(resolved, args, null);
  }

  externalRunning() {
    if (typeof this.alreadyRunning === "function") return Boolean(this.alreadyRunning());
    return uxplayAlreadyRunning({ platform: this.platform });
  }

  rememberArguments(windowTitle) {
    if (process.env.NODE_TEST_CONTEXT) return;
    try {
      writeUxplayArguments({ windowTitle, platform: this.platform });
    } catch (err) {
      console.error(err);
    }
  }

  launch(resolved, args, slot) {
    const airplay = this.getAirplayConfig() || {};
    this.rememberArguments(airplay.windowTitle);
    if (this.externalRunning()) {
      return { ok: true, already: true, external: true, command: resolved.command };
    }
    if (!claimUxplayLaunch()) {
      return { ok: true, already: true, external: true, command: resolved.command };
    }
    let child;
    try {
      if (this.externalRunning()) {
        return { ok: true, already: true, external: true, command: resolved.command };
      }
      child = this.spawn(resolved.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });
    } catch (err) {
      return { ok: false, error: err.message || "Could not start UxPlay" };
    } finally {
      releaseUxplayLaunch();
    }
    this.child = child;
    this.slot = slot;
    this.watchLogs(child);
    const noteExit = (message) => {
      if (this.child !== child) return;
      this.child = null;
      const exitedSlot = this.slot;
      this.slot = null;
      const wasActive = this.session.active;
      this.session.reset();
      if (wasActive && this.onSession) this.onSession("end", false);
      if (this.onExit && exitedSlot) this.onExit(exitedSlot, message);
      if (this.keepAlive && this.restarts < 5) {
        this.restarts += 1;
        const timer = setTimeout(() => {
          if (this.keepAlive && !this.child) this.ensureRunning();
        }, 2000);
        if (typeof timer.unref === "function") timer.unref();
      }
    };
    if (child && typeof child.on === "function") {
      child.on("error", (err) => noteExit(err.message || "UxPlay failed to start"));
      child.on("exit", (code) => noteExit(`UxPlay exited (${code})`));
    }
    return { ok: true, pid: child?.pid || null, command: resolved.command };
  }

  watchLogs(child) {
    const feed = (chunk) => {
      this.logBuffer += String(chunk);
      let splitAt = this.logBuffer.search(/\r?\n/);
      while (splitAt !== -1) {
        const line = this.logBuffer.slice(0, splitAt);
        this.logBuffer = this.logBuffer.slice(splitAt).replace(/^\r?\n/, "");
        this.consumeLog(line);
        splitAt = this.logBuffer.search(/\r?\n/);
      }
    };
    if (child?.stdout && typeof child.stdout.on === "function") child.stdout.on("data", feed);
    if (child?.stderr && typeof child.stderr.on === "function") child.stderr.on("data", feed);
  }

  consumeLog(line) {
    const event = this.session.noteLog(line);
    if (event && this.onSession) this.onSession(event, this.session.active);
    return event;
  }

  noteProbe(placed, { notify = true } = {}) {
    const event = this.session.noteProbe(Boolean(placed));
    if (event && notify && this.onSession) this.onSession(event, this.session.active);
    return event;
  }

  isActive() {
    return this.session.active;
  }

  pid() {
    return this.child?.pid || null;
  }

  stop() {
    this.keepAlive = false;
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
  findNestedUxplay,
  isUxplayExecutable,
  mergeUxplayArguments,
  uxplayArgumentPaths,
  writeUxplayArguments,
  uxplayAlreadyRunning,
  buildAirplayArgs,
  buildPlacementScript,
  interpretAirplayLog,
  normalizeAirplayTarget,
  AIRPLAY_TARGETS,
  AirplaySession,
  AirplayController,
};
