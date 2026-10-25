const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.platform !== "win32") {
  console.log("Update now trace check runs on Windows.");
  process.exit(0);
}
if (!process.env.GITHUB_ACTIONS && process.env.PINBALL_UPDATE_NOW_TEST !== "1") {
  console.log("Skipping Update now trace check outside CI.");
  process.exit(0);
}

const task = "PinballLandUpdateNow";
const root = path.join(__dirname, "..");
const dataDir = process.platform === "win32"
  ? "C:\\pl-update-now"
  : path.join(os.tmpdir(), "pl-update-now");
const smokePath = path.join(dataDir, "smoke-update.ps1");
const deadlineMs = 20000;

function schtasks(args) {
  return spawnSync("schtasks.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createTask() {
  const registerPath = path.join(dataDir, "register-now.ps1");
  const smoke = smokePath.replace(/'/g, "''");
  fs.writeFileSync(registerPath, [
    "$ErrorActionPreference = 'Continue'",
    `$smoke = '${smoke}'`,
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$action = New-ScheduledTaskAction -Execute $powershell -Argument \"-NoProfile -ExecutionPolicy Bypass -File `\"$smoke`\"\"",
    "$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse('2035-01-01T00:00:00'))",
    "$trigger.Enabled = $false",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)",
    "$user = $env:USERNAME",
    "$ok = $false",
    "foreach ($pair in @(@('Limited','S4U'), @('Limited','Interactive'), @('Highest','Interactive'))) {",
    "  try {",
    "    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $pair[1] -RunLevel $pair[0]",
    `    Register-ScheduledTask -TaskName '${task}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    "    Write-Output \"registered $($pair[0]) $($pair[1])\"",
    "    $ok = $true",
    "    break",
    "  } catch {",
    "    Write-Output \"register $($pair[0]) $($pair[1]) failed: $($_.Exception.Message)\"",
    "  }",
    "}",
    "if (-not $ok) { exit 1 }",
    "exit 0",
    "",
  ].join("\r\n"), "utf8");
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registerPath], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
}

function deleteTask() {
  schtasks(["/Delete", "/TN", task, "/F"]);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function postUpdate(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/updates/now`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pin": "2224" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Update now returned ${res.status}`);
  return data;
}

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const updater = path.join(root, "scripts", "invoke-update.ps1");
  fs.writeFileSync(smokePath, [
    "$ErrorActionPreference = 'Continue'",
    `$env:PINBALL_UPDATE_SMOKE = '1'`,
    `$env:PINBALL_DATA_DIR = ${psQuote(dataDir)}`,
    `& ${psQuote(updater)} -Mode now`,
    "exit 0",
    "",
  ].join("\r\n"), "utf8");

  deleteTask();
  const created = createTask();
  if (created.status !== 0) {
    fail(`Could not register ${task}.\n${created.stdout || ""}\n${created.stderr || ""}`);
    return;
  }
  console.log(String(created.stdout || "").trim());

  process.env.PINBALL_PLUG_MOCK = "1";
  const { Store } = require("../src/store");
  const { createApp } = require("../src/app");
  const store = await Store.load(path.join(dataDir, "state.json"));
  const { app } = createApp({
    store,
    pin: "2224",
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dataDir, "opdb"),
    dataDir,
    appRoot: root,
    airplay: {
      ready() { return { ok: false, error: "off" }; },
      ensureRunning() { return { ok: false }; },
      pid() { return null; },
      isActive() { return false; },
    },
    tunnelImpl: {
      start() {},
      stop() {},
      status() { return { url: "" }; },
    },
  });
  const server = await listen(app);
  try {
    const posted = await postUpdate(server.address().port);
    if (!posted.started) {
      fail(`Update now did not start the scheduled task. ${posted.note || ""}`);
      return;
    }
    const logFile = path.join(dataDir, "logs", "update.log");
    const deadline = Date.now() + deadlineMs;
    let log = "";
    while (Date.now() < deadline) {
      log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      if (/\binvoke now start\b/.test(log)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!/\binvoke now start\b/.test(log)) {
      fail(`No invoke now start trace within ${deadlineMs}ms.\n${log}`);
      return;
    }
    console.log("Update now wrote invoke now start.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    deleteTask();
  }
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
  deleteTask();
});
