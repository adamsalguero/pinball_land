const fsp = require("fs/promises");
const path = require("path");

const ZERO_SAMPLE = 64;

function stagePaths(appRoot) {
  const live = path.resolve(appRoot);
  const dir = path.dirname(live);
  const base = path.basename(live);
  return {
    live,
    staging: path.join(dir, `${base}-staging`),
    previous: path.join(dir, `${base}-previous`),
  };
}

function markerFile(dataDir) {
  return path.join(dataDir, "updates", "staging.json");
}

function statusFile(dataDir) {
  return path.join(dataDir, "logs", "update-status.json");
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, file);
}

function bufferIsZero(buf) {
  if (!buf || !buf.length) return false;
  for (const byte of buf) {
    if (byte !== 0) return false;
  }
  return true;
}

async function fileIsZeroFilled(file) {
  let handle;
  try {
    handle = await fsp.open(file, "r");
  } catch {
    return false;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) return false;
    const length = Math.min(ZERO_SAMPLE, stat.size);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, 0);
    return bufferIsZero(buf);
  } finally {
    await handle.close();
  }
}

async function walkFiles(root, onFile) {
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      await walkFiles(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

async function listZeroFilled(root, { includeModules = true } = {}) {
  const found = [];
  const targets = [
    ...(includeModules ? [path.join(root, "node_modules")] : []),
    path.join(root, "src"),
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
  ];
  for (const target of targets) {
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (await fileIsZeroFilled(target)) found.push(path.relative(root, target));
      continue;
    }
    await walkFiles(target, async (file) => {
      if (await fileIsZeroFilled(file)) found.push(path.relative(root, file));
    });
  }
  return found;
}

function electronPaths(root) {
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  return {
    pathFile: path.join(root, "node_modules", "electron", "path.txt"),
    binary: path.join(root, "node_modules", "electron", "dist", exe),
  };
}

async function checkElectron(root) {
  const { pathFile, binary } = electronPaths(root);
  if (!(await exists(pathFile))) return { ok: false, detail: "electron path.txt is missing" };
  if (await fileIsZeroFilled(pathFile)) return { ok: false, detail: "electron path.txt is zero-filled" };
  const text = (await fsp.readFile(pathFile, "utf8")).replace(/^\uFEFF/, "").trim();
  if (!text) return { ok: false, detail: "electron path.txt is blank" };
  if (!(await exists(binary))) return { ok: false, detail: "the Electron binary is missing" };
  let size = 0;
  try {
    size = (await fsp.stat(binary)).size;
  } catch {
    size = 0;
  }
  if (size <= 0) return { ok: false, detail: "the Electron binary is empty" };
  if (await fileIsZeroFilled(binary)) return { ok: false, detail: "the Electron binary is zero-filled" };
  return { ok: true, detail: "electron is installed" };
}

function zeroFilledResult(zeros) {
  const sample = zeros.slice(0, 5).join(", ");
  return { ok: false, detail: `${zeros.length} zero-filled file${zeros.length === 1 ? "" : "s"}: ${sample}` };
}

async function scanInstall(root) {
  if (!(await exists(root))) return { ok: false, detail: "install folder is missing" };
  const zeros = await listZeroFilled(root);
  if (zeros.length) return zeroFilledResult(zeros);
  return checkElectron(root);
}

async function quickScanInstall(root) {
  if (!(await exists(root))) return { ok: false, detail: "install folder is missing" };
  const zeros = await listZeroFilled(root, { includeModules: false });
  if (zeros.length) return zeroFilledResult(zeros);
  return checkElectron(root);
}

async function fsyncTree(root) {
  const targets = [
    path.join(root, "node_modules"),
    path.join(root, "src"),
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
  ];
  for (const target of targets) {
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      continue;
    }
    const files = [];
    if (stat.isFile()) files.push(target);
    else await walkFiles(target, async (file) => { files.push(file); });
    for (const file of files) {
      let handle;
      try {
        handle = await fsp.open(file, "r");
        await handle.sync();
      } catch {
        // A file that disappears mid-check is caught by the scan that follows.
      } finally {
        if (handle) await handle.close().catch(() => {});
      }
    }
  }
}

async function flushVolume(target, run) {
  await fsyncTree(target);
  if (process.platform !== "win32" || typeof run !== "function") return { ok: true, skipped: true };
  const drive = path.parse(path.resolve(target)).root.replace(/[\\/]$/, "");
  if (!/^[A-Za-z]:$/.test(drive)) return { ok: true, skipped: true };
  const result = await run("fsutil.exe", ["volume", "flush", drive], { timeoutMs: 20000 });
  return { ok: !result || result.ok !== false, detail: result && result.ok === false ? String(result.stderr || "") : "" };
}

async function readMarker(dataDir) {
  return readJson(markerFile(dataDir));
}

async function writeMarker(dataDir, marker) {
  await writeJson(markerFile(dataDir), marker);
}

async function clearMarker(dataDir) {
  await fsp.rm(markerFile(dataDir), { force: true });
}

async function recoverInterrupted(dataDir, paths = null) {
  const marker = await readMarker(dataDir);
  if (!marker) return { recovered: false };
  if (marker.phase === "staging") {
    if (paths) await fsp.rm(paths.staging, { recursive: true, force: true });
    await clearMarker(dataDir);
    return { recovered: true, discarded: true, detail: "discarded a partial staging folder" };
  }
  if (marker.phase === "swap" && paths && !(await exists(paths.live))) {
    const source = marker.prefer === "previous" ? paths.previous : paths.staging;
    if (await exists(source)) {
      await fsp.rename(source, paths.live);
      await clearMarker(dataDir);
      return {
        recovered: true,
        detail: marker.prefer === "previous" ? "restored the previous install after an interrupted swap" : "finished an interrupted install swap",
      };
    }
  }
  if (marker.phase === "swap") await clearMarker(dataDir);
  return { recovered: false };
}

async function restorePreviousInstall({ live, previous, dataDir }) {
  await writeMarker(dataDir, { phase: "swap", prefer: "previous", at: new Date().toISOString() });
  const hold = `${live}.bad`;
  await fsp.rm(hold, { recursive: true, force: true });
  await fsp.rename(live, hold);
  try {
    await fsp.rename(previous, live);
  } catch (err) {
    if (!(await exists(live)) && (await exists(hold))) await fsp.rename(hold, live);
    await clearMarker(dataDir);
    throw err;
  }
  await fsp.rm(previous, { force: true }).catch(() => {});
  if (await exists(hold)) await fsp.rename(hold, previous);
  await clearMarker(dataDir);
}

async function swapDirectories({ live, incoming, outgoing, dataDir, prefer }) {
  await writeMarker(dataDir, { phase: "swap", prefer, at: new Date().toISOString() });
  const retired = `${outgoing}.retiring`;
  await fsp.rm(retired, { recursive: true, force: true });
  if (await exists(outgoing)) await fsp.rename(outgoing, retired);
  await fsp.rename(live, outgoing);
  try {
    await fsp.rename(incoming, live);
  } catch (err) {
    if (await exists(outgoing) && !(await exists(live))) await fsp.rename(outgoing, live);
    if (await exists(retired) && !(await exists(outgoing))) await fsp.rename(retired, outgoing).catch(() => {});
    await clearMarker(dataDir);
    throw err;
  }
  await fsp.rm(retired, { recursive: true, force: true });
  await clearMarker(dataDir);
}

async function writeIntegrityStatus(dataDir, integrity) {
  const file = statusFile(dataDir);
  const current = (await readJson(file)) || {};
  current.integrityAt = integrity.at;
  current.integrityOk = integrity.ok === true;
  current.integrityDetail = integrity.detail || "";
  await writeJson(file, current);
}

module.exports = {
  stagePaths,
  scanInstall,
  quickScanInstall,
  fileIsZeroFilled,
  flushVolume,
  recoverInterrupted,
  restorePreviousInstall,
  swapDirectories,
  writeIntegrityStatus,
  readMarker,
  writeMarker,
  clearMarker,
  electronPaths,
};
