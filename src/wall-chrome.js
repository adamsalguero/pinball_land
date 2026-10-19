const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { WALL_CHROME_FLAGS, SOFTWARE_DECODE_FLAGS } = require("./playback-flags");

const FEATURE_FLAGS = "--disable-features=CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo";

function chromeProfileDir(dataDir, slot) {
  return path.join(dataDir, "chrome", `display${slot}`);
}

function pidFile(dataDir) {
  return path.join(dataDir, "chrome", "pids.json");
}

function findChrome() {
  if (process.env.PINBALL_CHROME && fs.existsSync(process.env.PINBALL_CHROME)) return process.env.PINBALL_CHROME;
  const candidates = process.platform === "win32"
    ? [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    ]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/local/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function wallChromeArgs({ url, profile, bounds, softwareDecode = false, kiosk = true } = {}) {
  const box = bounds || { x: 0, y: 0, width: 1280, height: 720 };
  const args = [
    `--user-data-dir=${profile}`,
    `--app=${url}`,
    `--window-position=${Number(box.x) || 0},${Number(box.y) || 0}`,
    `--window-size=${Math.max(320, Number(box.width) || 1280)},${Math.max(240, Number(box.height) || 720)}`,
    ...WALL_CHROME_FLAGS,
    "--disable-background-media-suspend",
    FEATURE_FLAGS,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
  ];
  if (kiosk) args.push("--kiosk");
  if (softwareDecode) args.push(...SOFTWARE_DECODE_FLAGS);
  return args;
}

function readPidFile(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pidFile(dataDir), "utf8"));
    const slots = Array.isArray(parsed?.slots) ? parsed.slots : [];
    return {
      root: String(parsed?.root || path.join(dataDir, "chrome")),
      slots: slots.map((row) => ({
        slot: Number(row.slot),
        pid: Number(row.pid),
        url: String(row.url || ""),
        x: Number(row.x) || 0,
        y: Number(row.y) || 0,
        width: Number(row.width) || 1280,
        height: Number(row.height) || 720,
      })).filter((row) => row.slot >= 1 && row.slot <= 3 && row.pid > 0),
    };
  } catch {
    return { root: path.join(dataDir, "chrome"), slots: [] };
  }
}

function writePidFile(dataDir, slots) {
  const file = pidFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    root: path.join(dataDir, "chrome"),
    slots,
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

function commandLine(pid) {
  const id = Number(pid);
  if (!id) return "";
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${id}").CommandLine`,
      ], { encoding: "utf8", timeout: 4000, windowsHide: true });
      return String(out || "");
    }
    return fs.readFileSync(`/proc/${id}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function ownsDisplayProfile(line, dataDir) {
  const text = String(line || "");
  if (!/chrome|chromium/i.test(text)) return false;
  const root = path.join(dataDir, "chrome");
  const folded = text.replace(/\//g, "\\").toLowerCase();
  const needle = root.replace(/\//g, "\\").toLowerCase();
  if (!folded.includes(needle)) return false;
  return /display[123]/.test(folded);
}

function killPid(pid) {
  const id = Number(pid);
  if (!id) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(id)], { stdio: "ignore", timeout: 5000, windowsHide: true });
      return;
    }
    process.kill(-id, "SIGKILL");
  } catch {
    try { process.kill(id, "SIGKILL"); } catch { /* already gone */ }
  }
}

function killOwned(dataDir) {
  const saved = readPidFile(dataDir);
  const killed = [];
  for (const row of saved.slots) {
    const line = commandLine(row.pid);
    if (!line || !ownsDisplayProfile(line, dataDir)) continue;
    killPid(row.pid);
    killed.push(row.pid);
  }
  return killed;
}

function launchDisplays({ dataDir, displays, softwareDecode = false, kiosk = true, chromePath } = {}) {
  if (!dataDir) throw new Error("launchDisplays needs a data dir");
  const browser = chromePath || findChrome();
  if (!browser) throw new Error("Google Chrome was not found.");
  killOwned(dataDir);
  const slots = [];
  for (const item of displays || []) {
    const slot = Number(item.slot);
    if (slot < 1 || slot > 3 || !item.url) continue;
    const bounds = item.bounds || { x: (slot - 1) * 80, y: (slot - 1) * 60, width: 1280, height: 720 };
    const profile = chromeProfileDir(dataDir, slot);
    fs.mkdirSync(profile, { recursive: true });
    const args = wallChromeArgs({
      url: item.url,
      profile,
      bounds,
      softwareDecode,
      kiosk,
    });
    const child = spawn(browser, args, { detached: true, stdio: "ignore" });
    child.unref();
    slots.push({
      slot,
      pid: child.pid,
      url: item.url,
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width) || 1280,
      height: Number(bounds.height) || 720,
    });
  }
  writePidFile(dataDir, slots);
  return slots;
}

function relaunchWallChrome({ dataDir, softwareDecode = true, port = 3000, kiosk = true } = {}) {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve({ skipped: "test" });
  if (!dataDir) return Promise.resolve({ skipped: "no-data-dir" });
  const saved = readPidFile(dataDir);
  if (!saved.slots.length) return Promise.resolve({ skipped: "no-pid-file" });
  const displays = saved.slots.map((row) => ({
    slot: row.slot,
    url: row.url || `http://127.0.0.1:${port}/display/${row.slot}`,
    bounds: { x: row.x, y: row.y, width: row.width, height: row.height },
  }));
  try {
    const slots = launchDisplays({ dataDir, displays, softwareDecode, kiosk });
    return Promise.resolve({ relaunched: slots.length, slots });
  } catch (err) {
    return Promise.reject(err);
  }
}

module.exports = {
  FEATURE_FLAGS,
  chromeProfileDir,
  pidFile,
  findChrome,
  wallChromeArgs,
  readPidFile,
  writePidFile,
  commandLine,
  ownsDisplayProfile,
  killOwned,
  launchDisplays,
  relaunchWallChrome,
};
