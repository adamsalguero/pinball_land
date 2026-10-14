const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

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
  dataLayout,
  migrateData,
  exists,
  isInside,
  copyMissing,
};
