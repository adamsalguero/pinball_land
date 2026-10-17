const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const COPY_PATHS = [
  ["config.json", "config.json"],
  ["data/state.json", "state.json"],
  ["data/media-library.json", "media-library.json"],
  ["data/devices.json", "devices.json"],
  ["data/certs", "certs"],
  ["data/uploads", "uploads"],
  ["data/opdb", "opdb"],
  ["data/guest-photos", "guest-photos"],
  ["data/logs", "logs"],
  ["media/library", "media/library"],
  ["media/halloween", "media/halloween"],
  ["media/christmas", "media/christmas"],
];

function defaultDataDir() {
  if (process.env.PINBALL_DATA_DIR) return path.resolve(process.env.PINBALL_DATA_DIR);
  if (process.platform === "win32") {
    const base = process.env.PROGRAMDATA || "C:\\ProgramData";
    return path.join(base, "PinballLand");
  }
  return path.join(os.homedir(), ".pinball-land");
}

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path;
}

function programDataDir(env = process.env, platform = process.platform) {
  const base = env.PROGRAMDATA || "C:\\ProgramData";
  return pathFor(platform).join(base, "PinballLand");
}

function userDataDir(env = process.env, platform = process.platform, homedir = os.homedir()) {
  const base = env.LOCALAPPDATA || pathFor(platform).join(homedir, "AppData", "Local");
  return pathFor(platform).join(base, "PinballLand");
}

function icaclsRepairCommand(dir) {
  return `icacls "${dir}" /grant "Users:(OI)(CI)M" /T /C`;
}

function isKioskInstall(env = process.env) {
  const flag = env.PINBALL_KIOSK;
  if (flag === "1" || flag === "true") return true;
  return env.npm_lifecycle_event === "kiosk";
}

function kioskTaskInstalled() {
  if (process.platform !== "win32") return false;
  try {
    execFileSync("schtasks.exe", ["/Query", "/TN", "PinballLandKiosk"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function userDataFallbackMessage(programData, userDir, err) {
  const why = err && (err.code || err.message) ? ` (${err.code || err.message})` : "";
  return [
    "PINBALL LAND DATA DIRECTORY",
    `ProgramData is not writable${why}: ${programData}`,
    "This is not the kiosk install, so Pinball Land will use a per-user folder.",
    `Using %LOCALAPPDATA%\\PinballLand (${userDir})`,
    "The wall PC must keep using C:\\ProgramData\\PinballLand and must not switch folders.",
    `From an elevated Command Prompt: ${icaclsRepairCommand(programData)}`,
  ].join("\n");
}

async function directoryWritable(dir, fsImpl = fsp) {
  const probe = path.join(dir, `.pinball-write-probe-${process.pid}`);
  try {
    if (typeof fsImpl.mkdir === "function") await fsImpl.mkdir(dir, { recursive: true });
    if (typeof fsImpl.open === "function") {
      const handle = await fsImpl.open(probe, "w");
      try {
        await handle.writeFile("ok");
        if (typeof handle.sync === "function") await handle.sync();
      } finally {
        if (typeof handle.close === "function") await handle.close();
      }
    } else {
      await fsImpl.writeFile(probe, "ok");
    }
    if (typeof fsImpl.unlink === "function") {
      try {
        await fsImpl.unlink(probe);
      } catch {
        // The write succeeded. A leftover probe does not mean the folder is locked.
      }
    }
    return { ok: true, error: null };
  } catch (err) {
    if (typeof fsImpl.unlink === "function") {
      try {
        await fsImpl.unlink(probe);
      } catch {
        // The probe is best-effort. The original error is the one that matters.
      }
    }
    return { ok: false, error: err };
  }
}

// Home `npm start` may not be allowed to write ProgramData (an elevated run can
// leave that folder owned by Administrators). The kiosk install must stay on
// ProgramData so venue data is not split across two folders.
async function resolveDataDir({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  fsImpl = fsp,
  kioskInstalled,
  log = console.warn,
} = {}) {
  if (env.PINBALL_DATA_DIR) return path.resolve(env.PINBALL_DATA_DIR);
  if (platform !== "win32") return path.join(homedir, ".pinball-land");
  const programData = programDataDir(env, platform);
  const writable = await directoryWritable(programData, fsImpl);
  if (writable.ok) return programData;
  const kiosk = isKioskInstall(env) || (typeof kioskInstalled === "boolean" ? kioskInstalled : kioskTaskInstalled());
  if (kiosk) return programData;
  const userDir = userDataDir(env, platform, homedir);
  log(userDataFallbackMessage(programData, userDir, writable.error));
  return userDir;
}

function dataLayout(dataDir) {
  return {
    root: dataDir,
    config: path.join(dataDir, "config.json"),
    state: path.join(dataDir, "state.json"),
    devices: path.join(dataDir, "devices.json"),
    certs: path.join(dataDir, "certs"),
    uploads: path.join(dataDir, "uploads"),
    opdb: path.join(dataDir, "opdb"),
    mediaCatalog: path.join(dataDir, "media-library.json"),
    media: path.join(dataDir, "media"),
    photos: path.join(dataDir, "guest-photos"),
    logs: path.join(dataDir, "logs"),
  };
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyMissing(src, dest) {
  if (!(await exists(src)) || (await exists(dest))) return false;
  const stat = await fsp.stat(src);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (stat.isDirectory()) {
    await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
  } else {
    await fsp.copyFile(src, dest);
  }
  return true;
}

async function migrateData({ appRoot, dataDir }) {
  const root = dataDir || defaultDataDir();
  await fsp.mkdir(root, { recursive: true });
  const marker = path.join(root, ".migrated");
  if (await exists(marker)) {
    return { dataDir: root, copied: [], already: true };
  }
  const copied = [];
  for (const [from, to] of COPY_PATHS) {
    const src = path.join(appRoot, from);
    const dest = path.join(root, to);
    if (from.endsWith(".json") && (await exists(src))) {
      const base = path.basename(src);
      if (base === "config.json" || base === "state.json" || base === "media-library.json" || base === "devices.json") {
        // Shipped config stays in the app folder as the seed. Copy once.
      }
    }
    if (await copyMissing(src, dest)) copied.push(to);
  }
  await fsp.writeFile(marker, `${new Date().toISOString()}\n`, "utf8");
  return { dataDir: root, copied, already: false };
}

function isInside(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

module.exports = {
  COPY_PATHS,
  defaultDataDir,
  programDataDir,
  userDataDir,
  icaclsRepairCommand,
  isKioskInstall,
  userDataFallbackMessage,
  directoryWritable,
  resolveDataDir,
  dataLayout,
  migrateData,
  exists,
  isInside,
  copyMissing,
};
