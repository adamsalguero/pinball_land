const { app, BrowserWindow, screen } = require("electron");
const { loadConfig } = require("./config");
const { startServer } = require("./server");
const { mapDisplaysToSlots } = require("./displays");
const path = require("path");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let port = null;
const windows = new Map();

function closeWindows() {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  windows.clear();
}

function openDisplayWindows() {
  closeWindows();
  const mapped = mapDisplaysToSlots(screen.getAllDisplays());
  if (!mapped.length) {
    console.warn("No displays detected.");
    return;
  }
  console.log(`Opening ${mapped.length} kiosk window(s) left-to-right.`);
  for (const item of mapped) {
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
      },
    });
    win.setMenuBarVisibility(false);
    win.setFullScreen(true);
    win.loadURL(`http://127.0.0.1:${port}/display/${item.slot}`);
    win.on("closed", () => {
      windows.delete(item.slot);
    });
    windows.set(item.slot, win);
  }
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

async function boot() {
  port = await ensureServer();
  await waitForHealth(port);
  openDisplayWindows();
  screen.on("display-added", openDisplayWindows);
  screen.on("display-removed", openDisplayWindows);
}

app.on("second-instance", () => {
  if (port) {
    openDisplayWindows();
  }
});

app.whenReady().then(() => boot().catch((err) => {
  console.error(err);
  app.quit();
}));

app.on("window-all-closed", () => {
  // Keep running so a display unplug/replug can recreate windows.
});

app.on("before-quit", () => {
  closeWindows();
});
