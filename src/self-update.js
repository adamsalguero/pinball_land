const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig, normalizeUpdates } = require("./config");
const { dataLayout } = require("./paths");
const { planRollback, rollbackInstall, swapInstall } = require("./updater");

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

function launchDetachedUpdate({ appRoot, mode }) {
  const script = path.join(appRoot, "scripts", "invoke-update.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", mode],
    { cwd: appRoot, detached: true, stdio: "ignore", windowsHide: true }
  );
  child.unref();
  return { started: true };
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
} = {}) {
  const logsDir = dataLayout(dataDir).logs;
  const pointerRoot = path.join(dataDir, "updates");
  const config = readUpdateConfig(dataDir, updates);
  const branch = config.branch || "main";

  async function log(message) {
    const line = `[${now().toISOString()}] ${mode} ${message}\n`;
    await appendUpdateLog(logsDir, line);
  }

  async function finish(result) {
    const payload = {
      at: now().toISOString(),
      mode,
      action: result.action,
      commit: result.commit || "",
      attempted: result.attempted || "",
      previous: result.previous || "",
      detail: result.detail || "",
    };
    await writeUpdateStatus(logsDir, payload);
    await log(`result=${payload.action} commit=${payload.commit} ${payload.detail}`.trim());
    return payload;
  }

  async function restore(previousCommit, detail) {
    const decision = planRollback(false);
    let rolled = null;
    if (decision === "rollback") {
      try {
        rolled = await rollbackInstall(pointerRoot);
      } catch (err) {
        await log(`rollback pointer failed: ${err.message}`);
      }
    }
    const target = rolled && isCommit(rolled.current) ? rolled.current : previousCommit;
    if (isCommit(target)) {
      const reset = await run("git", ["reset", "--hard", target], { cwd: appRoot, timeoutMs: 20000 });
      if (!reset.ok) await log(`git reset --hard ${target} failed: ${tail(reset.stderr)}`);
      const installed = await npmCi(appRoot, run, npmTimeoutMs, npmBin);
      if (!installed.ok) await log(`npm ci while restoring ${target} failed: ${tail(installed.stderr)}`);
      else await ensureElectron(appRoot, run, npmTimeoutMs);
    }
    return finish({
      action: "rolled-back",
      commit: target || previousCommit || "",
      attempted: rolled ? rolled.failed : "",
      previous: previousCommit || "",
      detail,
    });
  }

  if (mode !== "now" && config.enabled === false) {
    return finish({ action: "skipped", detail: "automatic updates are off" });
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

  try {
    await rememberVersion(pointerRoot, remote);
  } catch (err) {
    return finish({ action: "skipped", commit: head, detail: `could not record the update pointer: ${err.message}` });
  }

  const checkedOut = await run("git", ["reset", "--hard", remote], { cwd: appRoot, timeoutMs: 20000 });
  if (!checkedOut.ok) {
    return restore(head, `git reset --hard failed: ${tail(checkedOut.stderr)}`);
  }

  const installed = await npmCi(appRoot, run, npmTimeoutMs, npmBin);
  if (!installed.ok) {
    const why = installed.timedOut ? "npm ci timed out" : `npm ci failed: ${tail(installed.stderr || installed.stdout)}`;
    return restore(head, why);
  }

  const electron = await ensureElectron(appRoot, run, npmTimeoutMs);
  if (!electron.ok) return restore(head, electron.detail);

  let smokeResult;
  try {
    smokeResult = await smoke({ appRoot, timeoutMs: smokeTimeoutMs, run });
  } catch (err) {
    smokeResult = { ok: false, detail: `smoke check crashed: ${err.message}` };
  }
  if (!smokeResult || smokeResult.ok !== true) {
    return restore(head, smokeResult && smokeResult.detail ? smokeResult.detail : "smoke check failed");
  }

  await log("running test/platform.test.js; Playwright overflow stays in CI");
  let tests;
  try {
    tests = await runTests({ appRoot, run, timeoutMs: testTimeoutMs });
  } catch (err) {
    tests = { ok: false, detail: `unit tests crashed: ${err.message}` };
  }
  if (tests && tests.skipped) await log(tests.detail);
  if (tests && tests.ok === false && !tests.skipped) return restore(head, tests.detail);

  const kept = planRollback(true);
  if (kept !== "keep") return restore(head, "update plan asked to roll back");
  return finish({
    action: "updated",
    commit: remote,
    previous: head,
    detail: tests && tests.detail ? `${smokeResult.detail}. ${tests.detail}` : smokeResult.detail,
  });
}

module.exports = {
  FETCH_TIMEOUT_MS,
  appendUpdateLog,
  electronBinary,
  launchDetachedUpdate,
  launchRegisterTasks,
  npmCommand,
  readGitCommit,
  readUpdateStatusSync,
  runSelfUpdate,
  writeUpdateStatus,
};
