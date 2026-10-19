process.env.PINBALL_KIOSK = "1";
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, session, desktopCapturer } = require("electron");

app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-background-media-suspend");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const { loadConfig, writeDefaultPin } = require("./config");
const { DEFAULT_PIN } = require("./devices");
const { startServer } = require("./server");
const { mapDisplaysToSlots, windowLayoutKey } = require("./displays");
const { placementDecision, expectedMonitorCount, monitorSignature } = require("./watchdog");
const { defaultDataDir, dataLayout } = require("./paths");
const { launchDisplays } = require("./wall-chrome");
const { buildPlacementScript } = require("./airplay");

try {
  const saved = loadConfig(dataLayout(defaultDataDir()).config);
  if (saved.media && saved.media.softwareDecode === true) {
    app.commandLine.appendSwitch("disable-gpu-video-decode");
    app.commandLine.appendSwitch("disable-accelerated-video-decode");
  }
} catch (err) {
  console.error(err);
}
const { bootPlan } = require("./kiosk-boot");
const { discoverDisplayOrigins } = require("./display-origins");

const waitingPage = path.join(__dirname, "..", "public", "waiting.html");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let port = null;
let slotOrigins = null;
let layoutKey = "";
let lastMonitors = "";
let displaysConfig = null;
let serverReady = false;
let waiting = false;
let waitingSignature = "";
let tickRunning = false;
const windows = new Map();
let pollTimer = null;
let placing = false;
let captureDisplayId = null;
let operatorTray = null;

function closeWindows() {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  windows.clear();
}

function openWaitingWindows() {
  const displays = screen.getAllDisplays();
  const signature = displays.map((display) => String(display.id)).join(",") || "none";
  if (waiting && windows.size > 0 && signature === waitingSignature) return;
  waitingSignature = signature;
  closeWindows();
  waiting = true;
  const targets = displays.length ? displays : [null];
  targets.forEach((display, index) => {
    const bounds = display ? display.bounds : { x: 0, y: 0, width: 1280, height: 720 };
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
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
    win.loadFile(waitingPage);
    win.on("closed", () => {
      if (windows.get(`wait-${index}`) === win) windows.delete(`wait-${index}`);
    });
    windows.set(`wait-${index}`, win);
  });
  console.warn("Waiting for server. Retrying.");
}

function displayUrl(slot) {
  const base = slotOrigins && (slotOrigins[slot] || slotOrigins[String(slot)]);
  if (base) return `${base}/display/${slot}`;
  return `http://127.0.0.1:${port}/display/${slot}`;
}

function chromeFacade(row) {
  let visible = true;
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    isVisible: () => visible && !destroyed,
    hide() { visible = false; },
    show() { visible = true; },
    setFullScreen() {},
    close() {
      destroyed = true;
      if (!row.pid) return;
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill", ["/F", "/T", "/PID", String(row.pid)], { stdio: "ignore", windowsHide: true });
        } else {
          process.kill(-row.pid, "SIGKILL");
        }
      } catch {
        try { process.kill(row.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    },
  };
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
  let softwareDecode = false;
  try {
    softwareDecode = loadConfig(dataLayout(defaultDataDir()).config).media?.softwareDecode === true;
  } catch {
    softwareDecode = false;
  }
  try {
    const launched = launchDisplays({
      dataDir: defaultDataDir(),
      softwareDecode,
      kiosk: true,
      displays: mapped.windows.map((item) => ({
        slot: item.slot,
        url: displayUrl(item.slot),
        bounds: item.bounds,
      })),
    });
    if (launched.length) {
      for (const row of launched) windows.set(row.slot, chromeFacade(row));
      return;
    }
  } catch (err) {
    console.error(`Chrome per display failed (${err.message}). Falling back to Electron windows.`);
  }
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
    win.loadURL(displayUrl(item.slot));
    win.on("unresponsive", () => {
      console.warn(`Display ${item.slot} is unresponsive. Reloading.`);
      if (!win.isDestroyed()) win.reload();
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.warn(`Display ${item.slot} renderer ${details?.reason || "gone"}. Reloading.`);
      if (!win.isDestroyed()) win.loadURL(displayUrl(item.slot));
    });
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
  const seen = screen.getAllDisplays().length;
  const expected = expectedMonitorCount(data.displays);
  const monitorsNow = monitorSignature(screen.getAllDisplays());
  const decision = placementDecision({
    seen,
    expected,
    signature: monitorsNow,
    previousSignature: lastMonitors,
    windowCount: windows.size,
  });
  if (decision.waiting) {
    console.warn(`Waiting for ${expected} monitor(s); ${seen} connected. TVs on Kasa plugs can wake after the PC.`);
  }
  const signature = `${windowLayoutKey(data.displays, data.kiosk?.restartToken)}|${physical}`;
  if (signature !== layoutKey || decision.reopen) {
    layoutKey = signature;
    lastMonitors = monitorsNow;
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

async function tryBringUpServer() {
  const paths = dataLayout(defaultDataDir());
  const config = loadConfig(fs.existsSync(paths.config) ? paths.config : path.join(__dirname, "..", "config.json"));
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    if (res.ok) {
      console.log(`Using already-running server on port ${config.port}`);
      port = config.port;
      slotOrigins = await discoverDisplayOrigins(port);
      serverReady = true;
      return true;
    }
  } catch {
    // start our own
  }
  try {
    const started = await startServer();
    port = started.port;
    slotOrigins = started.displayOrigins || await discoverDisplayOrigins(port);
    await waitForHealth(port, 20);
    serverReady = true;
    return true;
  } catch (err) {
    console.error(err);
    serverReady = false;
    port = null;
    return false;
  }
}

function installOperatorTray() {
  try {
    const icon = nativeImage
      .createFromPath(path.join(__dirname, "..", "public", "icons", "admin-180.png"))
      .resize({ width: 16, height: 16 });
    operatorTray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    operatorTray.setToolTip("Pinball Land");
    operatorTray.setContextMenu(Menu.buildFromTemplate([
      {
        label: "Reset PIN to default",
        click() {
          const configPath = dataLayout(defaultDataDir()).config;
          writeDefaultPin(configPath);
          console.log(`PIN reset to ${DEFAULT_PIN} in ${configPath}`);
        },
      },
      { type: "separator" },
      { label: "Quit kiosk", click: () => app.quit() },
    ]));
    console.log("Tray: right-click the Pinball Land icon to reset the PIN.");
  } catch (err) {
    console.warn(`Tray is unavailable (${err.message}). Reset the PIN with: npm run reset-pin`);
  }
}

function scheduleRefresh() {
  if (!serverReady || !port) {
    openWaitingWindows();
    return;
  }
  refreshKiosk().catch((err) => {
    console.error(err);
    serverReady = false;
    openWaitingWindows();
  });
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    if (!serverReady) {
      const up = await tryBringUpServer();
      const plan = bootPlan({ serverReady: up });
      if (plan.screen === "waiting") {
        openWaitingWindows();
        return;
      }
      if (waiting) {
        waiting = false;
        waitingSignature = "";
        closeWindows();
      }
    }
    await refreshKiosk();
  } catch (err) {
    console.error(err);
    serverReady = false;
    if (!bootPlan({ serverReady: false }).quit) openWaitingWindows();
  } finally {
    tickRunning = false;
  }
}

async function boot() {
  installOperatorTray();
  installCaptureHandler();
  screen.on("display-added", () => {
    layoutKey = "";
    waitingSignature = "";
    scheduleRefresh();
  });
  screen.on("display-removed", () => {
    layoutKey = "";
    waitingSignature = "";
    scheduleRefresh();
  });
  pollTimer = setInterval(() => {
    tick().catch((err) => console.error(err));
  }, 2000);
  await tick();
}

app.on("second-instance", () => {
  if (!port) return;
  layoutKey = "";
  scheduleRefresh();
});

app.whenReady().then(() => boot().catch((err) => {
  console.error(err);
  if (!bootPlan({ serverReady: false }).quit) {
    try {
      openWaitingWindows();
    } catch (windowErr) {
      console.error(windowErr);
    }
  }
}));

app.on("window-all-closed", () => {
  // Keep running so a display unplug/replug or a config change can recreate windows.
});

app.on("child-process-gone", (_event, details) => {
  if (details?.type !== "GPU") return;
  console.warn("GPU process ended. Reopening the wall.");
  layoutKey = "";
  scheduleRefresh();
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
  closeWindows();
});
