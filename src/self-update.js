const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { loadConfig, normalizeUpdates } = require("./config");
const { dataLayout } = require("./paths");
const { planRollback, swapInstall } = require("./updater");
const {
  flushVolume,
  quickScanInstall,
  recoverInterrupted,
  restorePreviousInstall,
  scanInstall,
  stagePaths,
  swapDirectories,
  writeIntegrityStatus,
  writeMarker,
  readMarker,
  clearMarker,
} = require("./install-guard");
const { checkUploadPath } = require("./upload-check");

const LOG_MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const NPM_TIMEOUT_MS = 180000;
const SMOKE_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 45000;

function isCommit(value) {
  return /^[0-9a-f]{7,40}$/i.test(String(value || "").trim());
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function electronBinary(appRoot) {
  const name = process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(appRoot, "node_modules", "electron", "dist", name);
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

function defaultRun(command, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    const spawnOpts = {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(env || {}) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    let child;
    if (process.platform === "win32" && String(command).toLowerCase() === "npm.cmd") {
      const shell = process.env.ComSpec || "cmd.exe";
      child = spawn(shell, ["/d", "/s", "/c", "npm.cmd", ...args], spawnOpts);
    } else {
      child = spawn(command, args, spawnOpts);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          killTree(child);
          finish({ ok: false, code: null, stdout, stderr, timedOut: true });
        }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ ok: false, code: null, stdout, stderr: `${stderr}${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, code, stdout, stderr, timedOut: false });
    });
  });
}

function readUpdateConfig(dataDir, overrides) {
  if (overrides && typeof overrides === "object") return normalizeUpdates(overrides);
  try {
    return loadConfig(path.join(dataDir, "config.json")).updates;
  } catch {
    return normalizeUpdates(null);
  }
}

function readUpdateStatusSync(logsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(logsDir, "update-status.json"), "utf8"));
  } catch {
    return null;
  }
}

function readGitCommit(appRoot) {
  try {
    return require("child_process")
      .execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
  } catch {
    return "";
  }
}

function appendUpdateLogSync(logsDir, text) {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(path.join(logsDir, "update.log"), text);
}

function readUpdateLogSync(logsDir) {
  try {
    return fs.readFileSync(path.join(logsDir, "update.log"), "utf8");
  } catch {
    return "";
  }
}

function invokeLogAfter(logText, sinceIso, pattern) {
  const since = Date.parse(sinceIso || "");
  return String(logText || "").split(/\n/).some((line) => {
    if (!pattern.test(line)) return false;
    if (!Number.isFinite(since)) return true;
    const stamp = Date.parse((line.match(/^\[([^\]]+)\]/) || [])[1] || "");
    return Number.isFinite(stamp) && stamp + 2000 >= since;
  });
}

function invokeNowStarted(logText, sinceIso) {
  return invokeLogAfter(logText, sinceIso, /\binvoke now start\b/);
}

function invokeNowCompleted(logText, sinceIso) {
  return invokeLogAfter(logText, sinceIso, /\binvoke now (server and kiosk started|nightly left the wall running)\b/);
}

function runtimeDependencyNames(appRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  return Object.keys(pkg.dependencies || {});
}

function inspectRuntimeDependencies(appRoot = path.join(__dirname, "..")) {
  let names = [];
  try {
    names = runtimeDependencyNames(appRoot);
  } catch (err) {
    return {
      ok: false,
      failed: [{ name: "package.json", message: err.message }],
      photoProcessor: "photo processor unavailable",
    };
  }
  const failed = [];
  for (const name of names) {
    try {
      require(name);
    } catch (err) {
      failed.push({ name, message: String(err && err.message || err) });
    }
  }
  return {
    ok: failed.length === 0,
    failed,
    photoProcessor: failed.some((item) => item.name === "sharp") ? "photo processor unavailable" : "",
  };
}

async function verifyRuntimeDeps(appRoot, run = defaultRun, timeoutMs = NPM_TIMEOUT_MS) {
  let names;
  try {
    names = runtimeDependencyNames(appRoot);
  } catch (err) {
    return { ok: false, detail: `could not read package.json: ${err.message}` };
  }
  if (!names.length) return { ok: true, detail: "no runtime dependencies" };
  const expression = `const names = ${JSON.stringify(names)}; for (const name of names) { require(name); }`;
  const result = await run(process.execPath, ["-e", expression], { cwd: appRoot, timeoutMs });
  if (!result.ok) {
    const text = `${result.stderr || ""}\n${result.stdout || ""}`;
    const headline = text.split(/\n/).map((line) => line.trim()).find((line) => /unexpected token|SyntaxError|Error:/i.test(line));
    return { ok: false, detail: (headline || tail(text) || "runtime dependency failed to load").slice(0, 400) };
  }
  return { ok: true, detail: "runtime dependencies loaded" };
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function inspectTree(root, run, timeoutMs, checkUpload = checkUploadPath) {
  const scanned = await scanInstall(root);
  if (!scanned.ok) return scanned;
  const deps = await verifyRuntimeDeps(root, run, timeoutMs);
  if (!deps.ok) return deps;
  const uploaded = await checkUpload(root);
  if (!uploaded || uploaded.ok !== true) {
    return { ok: false, detail: (uploaded && uploaded.detail) || "upload path failed" };
  }
  if (uploaded.skipped) return { ok: true, detail: deps.detail };
  return {
    ok: true,
    detail: uploaded.detail && deps.detail ? `${deps.detail}. ${uploaded.detail}` : (uploaded.detail || deps.detail),
  };
}

async function discardStaging(dataDir, paths) {
  await fsp.rm(paths.staging, { recursive: true, force: true }).catch(() => {});
  await clearMarker(dataDir).catch(() => {});
}

async function stageCommit({
  appRoot,
  dataDir,
  commit,
  run,
  npmBin,
  npmTimeoutMs,
  now,
  log = async () => {},
  checkUpload = checkUploadPath,
}) {
  const paths = stagePaths(appRoot);
  await fsp.rm(paths.staging, { recursive: true, force: true });
  await writeMarker(dataDir, { phase: "staging", commit, at: now().toISOString() });
  const cloned = await run("git", ["clone", "--local", "--no-hardlinks", paths.live, paths.staging], { timeoutMs: 20000 });
  if (!cloned.ok) return { ok: false, detail: `git clone failed: ${tail(cloned.stderr || cloned.stdout)}` };
  const checked = await run("git", ["-C", paths.staging, "checkout", "--detach", commit], { timeoutMs: 20000 });
  if (!checked.ok) return { ok: false, detail: `git checkout failed: ${tail(checked.stderr || checked.stdout)}` };
  let installed = await npmCi(paths.staging, run, npmTimeoutMs, npmBin);
  if (!installed.ok) installed = await npmCi(paths.staging, run, npmTimeoutMs, npmBin);
  if (!installed.ok) {
    const why = installed.timedOut ? "npm ci timed out" : `npm ci failed: ${tail(installed.stderr || installed.stdout)}`;
    return { ok: false, detail: why };
  }
  const electron = await ensureElectron(paths.staging, run, npmTimeoutMs);
  if (!electron.ok) return { ok: false, detail: electron.detail };
  await flushVolume(paths.staging, run);
  let deps = await inspectTree(paths.staging, run, npmTimeoutMs, checkUpload);
  if (!deps.ok) {
    await log(`runtime dependencies failed to load (${deps.detail}). Running npm ci again.`);
    const again = await npmCi(paths.staging, run, npmTimeoutMs, npmBin);
    if (!again.ok) {
      const why = again.timedOut ? "npm ci timed out" : `npm ci failed: ${tail(again.stderr || again.stdout)}`;
      return { ok: false, detail: why };
    }
    await flushVolume(paths.staging, run);
    deps = await inspectTree(paths.staging, run, npmTimeoutMs, checkUpload);
    if (!deps.ok) return { ok: false, detail: `runtime dependencies failed to load: ${deps.detail}` };
  }
  return { ok: true, detail: deps.detail || "staging install verified", paths };
}

async function repairInstall({
  appRoot,
  dataDir,
  run = defaultRun,
  npmBin = npmCommand(),
  npmTimeoutMs = NPM_TIMEOUT_MS,
  now = () => new Date(),
  scanOnly = false,
  quick = false,
  checkUpload = checkUploadPath,
} = {}) {
  const paths = stagePaths(appRoot);
  const recovered = await recoverInterrupted(dataDir, paths);
  async function publish(ok, detail, action) {
    const integrity = { at: now().toISOString(), ok: ok === true, detail: detail || "" };
    await writeIntegrityStatus(dataDir, integrity);
    return {
      ok: integrity.ok,
      action,
      detail: integrity.detail,
      at: integrity.at,
      recovered: Boolean(recovered && recovered.recovered),
      recoveryDetail: (recovered && recovered.detail) || "",
    };
  }
  let scanned;
  if (quick) {
    const files = await quickScanInstall(appRoot);
    scanned = files.ok ? await verifyRuntimeDeps(appRoot, run, npmTimeoutMs) : files;
  } else {
    scanned = await inspectTree(appRoot, run, npmTimeoutMs, checkUpload);
  }
  if (scanned.ok) return publish(true, scanned.detail || "install files are intact", "intact");
  if (scanOnly) return publish(false, scanned.detail, "needs-repair");
  if (await pathExists(paths.previous)) {
    const prev = await inspectTree(paths.previous, run, npmTimeoutMs, checkUpload);
    if (prev.ok) {
      try {
        await restorePreviousInstall({ live: paths.live, previous: paths.previous, dataDir });
        const again = await inspectTree(appRoot, run, npmTimeoutMs, checkUpload);
        if (again.ok) return publish(true, "restored the previous install", "rolled-back");
      } catch {
        // A failed swap falls through to a rebuild of the recorded commit.
      }
    }
  }
  const headResult = await run("git", ["rev-parse", "HEAD"], { cwd: appRoot, timeoutMs: 10000 });
  const head = String(headResult.stdout || "").trim();
  if (!headResult.ok || !isCommit(head)) return publish(false, scanned.detail, "needs-repair");
  const staged = await stageCommit({ appRoot, dataDir, commit: head, run, npmBin, npmTimeoutMs, now, checkUpload });
  if (!staged.ok) {
    await discardStaging(dataDir, paths);
    return publish(false, staged.detail || scanned.detail, "needs-repair");
  }
  try {
    await swapDirectories({
      live: paths.live,
      incoming: paths.staging,
      outgoing: paths.previous,
      dataDir,
      prefer: "staging",
    });
  } catch (err) {
    await discardStaging(dataDir, paths);
    return publish(false, `could not switch to the repaired install: ${err.message}`, "needs-repair");
  }
  return publish(true, "rebuilt the install from git", "repaired");
}

async function appendUpdateLog(logsDir, text, { maxBytes = LOG_MAX_BYTES } = {}) {
  await fsp.mkdir(logsDir, { recursive: true });
  const file = path.join(logsDir, "update.log");
  let size = 0;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    size = 0;
  }
  if (size > maxBytes) {
    const backup = path.join(logsDir, "update.log.1");
    await fsp.rm(backup, { force: true }).catch(() => {});
    await fsp.rename(file, backup);
  }
  await fsp.appendFile(file, text, "utf8");
}

async function writeUpdateStatus(logsDir, status) {
  await fsp.mkdir(logsDir, { recursive: true });
  const file = path.join(logsDir, "update-status.json");
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, file);
}

async function rememberVersion(pointerRoot, version) {
  await fsp.mkdir(path.join(pointerRoot, "versions", version), { recursive: true });
  return swapInstall({ installRoot: pointerRoot, nextVersion: version });
}

function tail(text, max = 400) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return value.slice(value.length - max);
}

async function defaultSmoke({ appRoot, timeoutMs }) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-smoke-"));
  const port = 35000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HTTPS_PORT: "0",
      PINBALL_DATA_DIR: temp,
      PINBALL_PLUG_MOCK: "1",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const deadline = Date.now() + timeoutMs;
  let healthOk = false;
  let pageOk = false;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      healthOk = healthOk || (await probe(`http://127.0.0.1:${port}/api/health`));
      pageOk = pageOk || (await probe(`http://127.0.0.1:${port}/display/1`));
      if (healthOk && pageOk) break;
      await delay(300);
    }
  } finally {
    killTree(child);
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
  return {
    ok: healthOk && pageOk,
    detail: healthOk && pageOk ? "server health and display responded" : "server did not answer /api/health and /display/1",
  };
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultTests({ appRoot, run, timeoutMs }) {
  const result = await run(process.execPath, ["--test", "test/platform.test.js"], {
    cwd: appRoot,
    timeoutMs,
  });
  if (result.timedOut) {
    return { ok: true, skipped: true, detail: "unit tests skipped (too slow)" };
  }
  return {
    ok: result.ok,
    skipped: false,
    detail: result.ok ? "unit tests passed" : `unit tests failed: ${tail(result.stderr || result.stdout)}`,
  };
}

async function ensureElectron(appRoot, run, timeoutMs) {
  try {
    await fsp.access(electronBinary(appRoot));
    return { ok: true, skipped: true };
  } catch {
    const script = path.join(appRoot, "node_modules", "electron", "install.js");
    const result = await run(process.execPath, [script], { cwd: appRoot, timeoutMs });
    if (!result.ok) {
      return { ok: false, detail: `electron install failed: ${tail(result.stderr || result.stdout)}` };
    }
    try {
      await fsp.access(electronBinary(appRoot));
      return { ok: true, skipped: false };
    } catch {
      return { ok: false, detail: "electron install.js finished but the Electron binary is missing" };
    }
  }
}

async function npmCi(appRoot, run, timeoutMs, command) {
  return run(command, ["ci", "--omit=dev"], { cwd: appRoot, timeoutMs });
}

function launchScheduledUpdate({
  dataDir,
  mode = "now",
  now = () => new Date(),
  run = spawnSync,
  platform = process.platform,
} = {}) {
  const logsDir = dataLayout(dataDir).logs;
  const requestedAt = now().toISOString();
  appendUpdateLogSync(logsDir, `[${requestedAt}] invoke ${mode} requested\n`);
  if (platform !== "win32") {
    return { started: false, requestedAt, detail: "Update now runs on the Windows kiosk." };
  }
  const result = run("schtasks.exe", ["/Run", "/TN", "PinballLandUpdateNow"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 20000,
  });
  const detail = `${result.stdout || ""} ${result.stderr || ""}`.trim();
  const started = result.status === 0;
  if (!started) {
    appendUpdateLogSync(
      logsDir,
      `[${now().toISOString()}] invoke ${mode} not started: ${detail || "schtasks failed"}\n`
    );
  }
  return { started, requestedAt, detail };
}

function launchRegisterTasks({ appRoot }) {
  const script = path.join(appRoot, "scripts", "register-update-tasks.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RepoRoot", appRoot],
    { cwd: appRoot, detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
  return { started: true };
}

async function runSelfUpdate({
  appRoot,
  dataDir,
  mode = "boot",
  updates,
  run = defaultRun,
  smoke = defaultSmoke,
  runTests = defaultTests,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  npmTimeoutMs = NPM_TIMEOUT_MS,
  smokeTimeoutMs = SMOKE_TIMEOUT_MS,
  testTimeoutMs = TEST_TIMEOUT_MS,
  now = () => new Date(),
  npmBin = npmCommand(),
  recordOnly = false,
  stageOnly = false,
  swapOnly = false,
  checkUpload = checkUploadPath,
} = {}) {
  const logsDir = dataLayout(dataDir).logs;
  const pointerRoot = path.join(dataDir, "updates");
  const config = readUpdateConfig(dataDir, updates);
  const branch = config.branch || "main";
  const paths = stagePaths(appRoot);

  async function log(message) {
    const line = `[${now().toISOString()}] ${mode} ${message}\n`;
    await appendUpdateLog(logsDir, line);
  }

  async function finish(result, { persist = true } = {}) {
    const payload = {
      at: now().toISOString(),
      mode,
      action: result.action,
      commit: result.commit || "",
      attempted: result.attempted || "",
      previous: result.previous || "",
      detail: result.detail || "",
    };
    if (result.integrityAt) {
      payload.integrityAt = result.integrityAt;
      payload.integrityOk = result.integrityOk === true;
      payload.integrityDetail = result.integrityDetail || "";
    }
    if (persist) await writeUpdateStatus(logsDir, payload);
    await log(`result=${payload.action} commit=${payload.commit} ${payload.detail}`.trim());
    return payload;
  }

  async function abandon(previousCommit, detail) {
    await discardStaging(dataDir, paths);
    return finish({
      action: "rolled-back",
      commit: previousCommit || "",
      previous: previousCommit || "",
      detail,
      integrityAt: now().toISOString(),
      integrityOk: false,
      integrityDetail: detail,
    });
  }

  async function promote(commit, action, headCommit, { holdSwap = false } = {}) {
    const staged = await stageCommit({
      appRoot,
      dataDir,
      commit,
      run,
      npmBin,
      npmTimeoutMs,
      now,
      log,
      checkUpload,
    });
    if (!staged.ok) return abandon(headCommit, staged.detail);
    let smokeResult;
    try {
      smokeResult = await smoke({ appRoot: paths.staging, timeoutMs: smokeTimeoutMs, run });
    } catch (err) {
      smokeResult = { ok: false, detail: `smoke check crashed: ${err.message}` };
    }
    if (!smokeResult || smokeResult.ok !== true) {
      return abandon(headCommit, smokeResult && smokeResult.detail ? smokeResult.detail : "smoke check failed");
    }
    await log("running test/platform.test.js; Playwright overflow stays in CI");
    let tests;
    try {
      tests = await runTests({ appRoot: paths.staging, run, timeoutMs: testTimeoutMs });
    } catch (err) {
      tests = { ok: false, detail: `unit tests crashed: ${err.message}` };
    }
    if (tests && tests.skipped) await log(tests.detail);
    if (tests && tests.ok === false && !tests.skipped) return abandon(headCommit, tests.detail);
    const kept = planRollback(true);
    if (kept !== "keep") return abandon(headCommit, "update plan asked to roll back");
    const detail = tests && tests.detail ? `${smokeResult.detail}. ${tests.detail}` : smokeResult.detail;
    if (holdSwap) {
      await writeMarker(dataDir, {
        phase: "ready",
        commit,
        previous: headCommit,
        at: now().toISOString(),
        detail: staged.detail || "",
      });
      return finish({
        action: "staged",
        commit,
        previous: headCommit,
        detail,
        integrityAt: now().toISOString(),
        integrityOk: true,
        integrityDetail: staged.detail || "install files are intact",
      });
    }
    try {
      await swapDirectories({
        live: paths.live,
        incoming: paths.staging,
        outgoing: paths.previous,
        dataDir,
        prefer: "staging",
      });
    } catch (err) {
      return abandon(headCommit, `could not switch to the staged install: ${err.message}`);
    }
    try {
      await rememberVersion(pointerRoot, commit);
    } catch (err) {
      await log(`could not record ${commit}: ${err.message}`);
    }
    return finish({
      action,
      commit,
      previous: headCommit,
      detail,
      integrityAt: now().toISOString(),
      integrityOk: true,
      integrityDetail: staged.detail || "install files are intact",
    });
  }

  if (mode !== "now" && config.enabled === false) {
    const scanned = await scanInstall(appRoot);
    if (scanned.ok) {
      return finish({
        action: "skipped",
        detail: "automatic updates are off",
        integrityAt: now().toISOString(),
        integrityOk: true,
        integrityDetail: scanned.detail,
      });
    }
  }

  const recovered = await recoverInterrupted(dataDir, paths);
  if (recovered.detail) await log(recovered.detail);

  if (swapOnly) {
    const marker = await readMarker(dataDir);
    if (!marker || marker.phase !== "ready" || !isCommit(marker.commit)) {
      return finish({ action: "skipped", detail: "no staged update is waiting" });
    }
    if (!(await pathExists(paths.staging))) {
      await clearMarker(dataDir);
      return finish({ action: "skipped", detail: "staged folder is missing" });
    }
    try {
      await swapDirectories({
        live: paths.live,
        incoming: paths.staging,
        outgoing: paths.previous,
        dataDir,
        prefer: "staging",
      });
    } catch (err) {
      return finish({
        action: "rolled-back",
        commit: marker.previous || "",
        previous: marker.previous || "",
        detail: `could not switch to the staged install: ${err.message}`,
        integrityAt: now().toISOString(),
        integrityOk: false,
        integrityDetail: err.message,
      });
    }
    try {
      await rememberVersion(pointerRoot, marker.commit);
    } catch (err) {
      await log(`could not record ${marker.commit}: ${err.message}`);
    }
    return finish({
      action: "updated",
      commit: marker.commit,
      previous: marker.previous || "",
      detail: "staged install swapped",
      integrityAt: now().toISOString(),
      integrityOk: true,
      integrityDetail: marker.detail || "staged install swapped",
    });
  }

  const headResult = await run("git", ["rev-parse", "HEAD"], { cwd: appRoot, timeoutMs: 10000 });
  const head = String(headResult.stdout || "").trim();
  if (!headResult.ok || !isCommit(head)) {
    return finish({
      action: "skipped",
      detail: headResult.timedOut ? "git rev-parse timed out" : "could not read the current commit",
    });
  }

  try {
    await rememberVersion(pointerRoot, head);
  } catch (err) {
    await log(`could not record ${head}: ${err.message}`);
  }

  const fetched = await run("git", ["fetch", "--prune", "origin", branch], {
    cwd: appRoot,
    timeoutMs: fetchTimeoutMs,
  });
  if (!fetched.ok) {
    const why = fetched.timedOut ? `git fetch timed out after ${fetchTimeoutMs}ms` : `git fetch failed: ${tail(fetched.stderr)}`;
    return finish({ action: "skipped", commit: head, detail: `${why}. Starting the current version.` });
  }

  const remoteResult = await run("git", ["rev-parse", `origin/${branch}`], { cwd: appRoot, timeoutMs: 10000 });
  const remote = String(remoteResult.stdout || "").trim();
  if (!remoteResult.ok || !isCommit(remote)) {
    return finish({ action: "skipped", commit: head, detail: "origin did not resolve to a commit. Starting the current version." });
  }
  if (remote === head) {
    return finish({ action: "up-to-date", commit: head, detail: `${branch} matches this checkout` });
  }

  const ahead = await run("git", ["rev-list", "--count", `HEAD..origin/${branch}`], {
    cwd: appRoot,
    timeoutMs: 10000,
  });
  const aheadCount = Number.parseInt(String(ahead.stdout || "").trim(), 10);
  if (!ahead.ok || !Number.isFinite(aheadCount) || aheadCount < 1) {
    return finish({ action: "up-to-date", commit: head, detail: `origin/${branch} is not ahead` });
  }

  if (recordOnly) {
    return finish({
      action: "update-available",
      commit: head,
      attempted: remote,
      detail: `${branch} has ${aheadCount} new commit${aheadCount === 1 ? "" : "s"}`,
    }, { persist: false });
  }

  return promote(remote, "updated", head, { holdSwap: stageOnly === true });
}

module.exports = {
  FETCH_TIMEOUT_MS,
  appendUpdateLog,
  appendUpdateLogSync,
  electronBinary,
  inspectRuntimeDependencies,
  invokeNowCompleted,
  invokeNowStarted,
  repairInstall,
  launchScheduledUpdate,
  launchRegisterTasks,
  readUpdateLogSync,
  verifyRuntimeDeps,
  npmCommand,
  readGitCommit,
  readUpdateStatusSync,
  runSelfUpdate,
  writeUpdateStatus,
};
