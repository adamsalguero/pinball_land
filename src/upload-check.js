const { spawn } = require("child_process");
const fsp = require("fs/promises");
const path = require("path");
const {
  restorePreviousInstall,
  stagePaths,
  writeIntegrityStatus,
} = require("./install-guard");

const CHECK_TIMEOUT_MS = 30000;

function exists(target) {
  return fsp.access(target).then(() => true).catch(() => false);
}

function runWorker(appRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "upload-worker.js"), appRoot], {
      cwd: appRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, detail: "upload path failed: timed out" });
    }, CHECK_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ ok: false, detail: `upload path failed: ${err.message}`.slice(0, 400) });
    });
    child.on("close", () => {
      const line = stdout.trim().split(/\n/).filter(Boolean).pop();
      try {
        const parsed = JSON.parse(line);
        finish({
          ok: parsed.ok === true,
          detail: String(parsed.detail || (parsed.ok ? "upload path ok" : "upload path failed")).slice(0, 400),
        });
      } catch {
        const text = `${stderr || ""}\n${stdout || ""}`.trim() || "no result";
        finish({ ok: false, detail: `upload path failed: ${text}`.slice(0, 400) });
      }
    });
  });
}

async function checkUploadPath(appRoot) {
  const photos = path.join(appRoot, "src", "photos.js");
  if (!(await exists(photos))) {
    return { ok: true, skipped: true, detail: "upload check skipped; no photo processor" };
  }
  return runWorker(appRoot);
}

async function copySharp(fromRoot, toRoot) {
  const fromSharp = path.join(fromRoot, "node_modules", "sharp");
  if (!(await exists(fromSharp))) throw new Error("backup tree has no sharp package");
  const toModules = path.join(toRoot, "node_modules");
  await fsp.mkdir(toModules, { recursive: true });
  const toSharp = path.join(toModules, "sharp");
  await fsp.rm(toSharp, { recursive: true, force: true });
  await fsp.cp(fromSharp, toSharp, { recursive: true });
  const fromImg = path.join(fromRoot, "node_modules", "@img");
  if (await exists(fromImg)) {
    const toImg = path.join(toModules, "@img");
    await fsp.rm(toImg, { recursive: true, force: true });
    await fsp.cp(fromImg, toImg, { recursive: true });
  }
}

async function publish(dataDir, ok, detail, action, now) {
  const integrity = { at: now().toISOString(), ok: ok === true, detail: detail || "" };
  await writeIntegrityStatus(dataDir, integrity);
  return { ok: integrity.ok, action, detail: integrity.detail, at: integrity.at };
}

async function repairUploadPath({
  appRoot,
  dataDir,
  now = () => new Date(),
  copyPackage = copySharp,
  check = checkUploadPath,
} = {}) {
  const paths = stagePaths(appRoot);
  const failed = await check(appRoot);
  if (failed.ok) return publish(dataDir, true, failed.detail || "upload path ok", failed.skipped ? "skipped" : "intact", now);
  for (const donor of [paths.staging, paths.previous]) {
    if (!(await exists(donor))) continue;
    const donorCheck = await check(donor);
    if (!donorCheck.ok || donorCheck.skipped) continue;
    try {
      await copyPackage(donor, appRoot);
    } catch {
      continue;
    }
    const again = await check(appRoot);
    if (again.ok && !again.skipped) {
      const from = path.basename(donor);
      return publish(dataDir, true, `reinstalled sharp from ${from}. ${again.detail}`, "repaired", now);
    }
  }
  if (await exists(paths.previous)) {
    const prev = await check(paths.previous);
    if (prev.ok && !prev.skipped) {
      try {
        await restorePreviousInstall({ live: paths.live, previous: paths.previous, dataDir });
        const again = await check(appRoot);
        if (again.ok && !again.skipped) {
          return publish(dataDir, true, `restored the previous install. ${again.detail}`, "rolled-back", now);
        }
      } catch {
        // A failed swap falls through to the full install repair.
      }
    }
  }
  return publish(dataDir, false, failed.detail || "upload path failed", "needs-repair", now);
}

module.exports = {
  checkUploadPath,
  copySharp,
  repairUploadPath,
};
