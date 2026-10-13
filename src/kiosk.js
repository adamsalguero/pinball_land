const { app, BrowserWindow, screen, session, desktopCapturer } = require("electron");

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const { spawn } = require("child_process");
const path = require("path");
const { loadConfig } = require("./config");
const { startServer } = require("./server");
const { mapDisplaysToSlots, windowLayoutKey } = require("./displays");
const { buildPlacementScript } = require("./airplay");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let port = null;
let layoutKey = "";
let displaysConfig = null;
const windows = new Map();
let pollTimer = null;
let placing = false;
let captureDisplayId = null;

function closeWindows() {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  windows.clear();
}

function openDisplayWindows() {
  closeWindows();
  const mapped = mapDisplaysToSlots(screen.getAllDisplays(), displaysConfig || {});
  if (mapped.skipped.length) {
    console.warn(
      `Configured display(s) ${mapped.skipped.join(", ")} have no physical monitor. Skipping those windows.`
    );
  }
  if (!mapped.windows.length) {
    console.warn("No kiosk windows to open. Check Displays in the control app and the connected monitors.");
    return;
  }
  console.log(`Opening kiosk window(s) for display ${mapped.windows.map((item) => item.slot).join(", ")}.`);
  for (const item of mapped.windows) {
    const { x, y, width, height } = item.bounds;
    const win = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      fullscreen: true,
      simpleFullscreen: true,
      autoHideMenuBar: true,
      skipTaskbar: true,
      backgroundColor: "#1a1916",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.setFullScreen(true);
    win.loadURL(`http://127.0.0.1:${port}/display/${item.slot}`);
    win.on("closed", () => {
      if (windows.get(item.slot) === win) windows.delete(item.slot);
    });
    windows.set(item.slot, win);
  }
}

function runPlacement(pid, bounds) {
  if (process.platform !== "win32") return Promise.resolve(false);
  const script = buildPlacementScript({ pid, bounds });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(out.includes("PLACED")));
  });
}

function installCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const wanted = captureDisplayId == null ? "" : String(captureDisplayId);
      const source = sources.find((item) => String(item.display_id) === wanted) || sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source });
    } catch (err) {
      console.error(err);
      callback({});
    }
  });
}

async function placeAirplay(data) {
  if (placing) return data;
  placing = true;
  try {
    const mapped = mapDisplaysToSlots(screen.getAllDisplays(), displaysConfig || {});
    const target = data.airplay?.target || "off";
    const pid = data.airplay?.pid;
    const primary = data.airplay?.primarySlot;
    let placed = false;
    if (pid && target !== "off" && primary && process.platform === "win32") {
      const item = mapped.windows.find((entry) => String(entry.slot) === String(primary));
      if (item) {
        captureDisplayId = item.id;
        placed = await runPlacement(pid, item.bounds);
      }
    }
    if (process.platform === "win32" && pid) {
      await fetch(`http://127.0.0.1:${port}/api/airplay/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ placed }),
      }).catch(() => {});
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (res.ok) data = await res.json();
    }
    for (const item of mapped.windows) {
      const win = windows.get(item.slot);
      if (!win || win.isDestroyed()) continue;
      const session = data.presentations?.[String(item.slot)];
      const native = session?.source === "airplay" && session.helper?.capture !== true && String(item.slot) === String(data.airplay?.primarySlot);
      if (native && placed) {
        if (win.isVisible()) win.hide();
      } else if (!win.isVisible()) {
        win.show();
        win.setFullScreen(true);
      }
    }
    return data;
  } finally {
    placing = false;
  }
}

async function reportMonitors() {
  const displays = screen.getAllDisplays().map((display) => ({
    id: display.id,
    bounds: display.bounds,
  }));
  await fetch(`http://127.0.0.1:${port}/api/kiosk/monitors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displays }),
  });
}

async function refreshKiosk() {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  if (!res.ok) return;
  const data = await res.json();
  displaysConfig = data.displays;
  const physical = screen
    .getAllDisplays()
    .map((display) => `${display.id}:${display.bounds?.x}:${display.bounds?.y}:${display.bounds?.width}:${display.bounds?.height}`)
    .join("|");
  const signature = `${windowLayoutKey(data.displays, data.kiosk?.restartToken)}|${physical}`;
  if (signature !== layoutKey) {
    layoutKey = signature;
    openDisplayWindows();
  }
  await placeAirplay(data);
  await reportMonitors();
}

async function waitForHealth(targetPort, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/api/health`);
      if (res.ok) return true;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Kiosk server did not become ready on port ${targetPort}`);
}

async function ensureServer() {
  const config = loadConfig(path.join(__dirname, "..", "config.json"));
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    if (res.ok) {
      console.log(`Using already-running server on port ${config.port}`);
      return config.port;
    }
  } catch {
    // start our own
  }
  const started = await startServer();
  return started.port;
}

function scheduleRefresh() {
  refreshKiosk().catch((err) => console.error(err));
}

async function boot() {
  installCaptureHandler();
  port = await ensureServer();
  await waitForHealth(port);
  await refreshKiosk();
  screen.on("display-added", () => {
    layoutKey = "";
    scheduleRefresh();
  });
  screen.on("display-removed", () => {
    layoutKey = "";
    scheduleRefresh();
  });
  pollTimer = setInterval(scheduleRefresh, 2000);
}

app.on("second-instance", () => {
  if (!port) return;
  layoutKey = "";
  scheduleRefresh();
});

app.whenReady().then(() => boot().catch((err) => {
  console.error(err);
  app.quit();
}));

app.on("window-all-closed", () => {
  // Keep running so a display unplug/replug or a config change can recreate windows.
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
  closeWindows();
});
