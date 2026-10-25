const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

if (process.platform !== "win32") {
  console.log("Cold boot order check runs on Windows.");
  process.exit(0);
}
if (!process.env.GITHUB_ACTIONS && process.env.PINBALL_BOOT_ORDER_TEST !== "1") {
  console.log("Skipping cold boot order check outside CI.");
  process.exit(0);
}

const root = path.join(__dirname, "..");
const base = "C:\\pl-boot-order";
const appRoot = path.join(base, "app");
const origin = path.join(base, "origin.git");
const dataDir = path.join(base, "data");
const binDir = path.join(base, "bin");
const dnsFile = path.join(base, "dns-ready");
const kioskFile = path.join(dataDir, "kiosk-opened.txt");
const port = 18766;
const serverTask = "PinballLandServer";
const kioskTask = "PinballLandKiosk";

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}\n${result.stderr || result.stdout || ""}`);
  }
}

function schtasks(args) {
  spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function orderOf(log, phrases) {
  let at = -1;
  for (const phrase of phrases) {
    const next = log.indexOf(phrase, at + 1);
    if (next < 0) throw new Error(`missing "${phrase}"\n${log}`);
    at = next;
  }
}

function registerTasks() {
  const serverPs1 = path.join(base, "wall-server.ps1");
  const kioskPs1 = path.join(base, "wall-kiosk.ps1");
  const registerPs1 = path.join(base, "register-wall.ps1");
  fs.writeFileSync(serverPs1, [
    "$ErrorActionPreference = 'Continue'",
    `$env:PORT = '${port}'`,
    `& ${psQuote(process.execPath)} ${psQuote(path.join(appRoot, "src", "server.js"))}`,
    "",
  ].join("\r\n"), "utf8");
  fs.writeFileSync(kioskPs1, [
    "$ErrorActionPreference = 'Continue'",
    `Set-Content -LiteralPath ${psQuote(kioskFile)} -Value 'fullscreen kiosk' -Encoding UTF8`,
    "exit 0",
    "",
  ].join("\r\n"), "utf8");
  const tasks = [
    [serverTask, serverPs1],
    [kioskTask, kioskPs1],
  ];
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$user = $env:USERNAME",
  ];
  for (const [name, file] of tasks) {
    lines.push(`$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${psQuote(file)}"`);
    lines.push("$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse('2035-01-01T00:00:00'))");
    lines.push("$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)");
    lines.push("$ok = $false");
    lines.push("foreach ($pair in @(@('Limited','S4U'), @('Limited','Interactive'), @('Highest','Interactive'))) {");
    lines.push("  try {");
    lines.push("    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType $pair[1] -RunLevel $pair[0]");
    lines.push(`    Register-ScheduledTask -TaskName '${name}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`);
    lines.push("    Write-Output \"registered $($pair[0]) $($pair[1])\"");
    lines.push("    $ok = $true");
    lines.push("    break");
    lines.push("  } catch {");
    lines.push("    Write-Output \"register $($pair[0]) $($pair[1]) failed: $($_.Exception.Message)\"");
    lines.push("  }");
    lines.push("}");
    lines.push("if (-not $ok) { exit 1 }");
  }
  lines.push("exit 0", "");
  fs.writeFileSync(registerPs1, lines.join("\r\n"), "utf8");
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registerPs1], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
}

function cleanup() {
  for (const name of [serverTask, kioskTask]) {
    schtasks(["/End", "/TN", name]);
    schtasks(["/Delete", "/TN", name, "/F"]);
  }
}

function buildFixture() {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(path.join(appRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "test"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(appRoot, ".gitignore"), "node_modules\n", "utf8");
  fs.writeFileSync(path.join(appRoot, "package.json"), `${JSON.stringify({ name: "pinball-boot-fixture", private: true, version: "1.0.0" })}\n`, "utf8");
  fs.writeFileSync(path.join(appRoot, "src", "server.js"), [
    "const http = require('http');",
    "const port = Number(process.env.PORT) || 3010;",
    "http.createServer((req, res) => {",
    "  const url = req.url || '/';",
    "  if (url.startsWith('/api/health') || url.startsWith('/display/')) {",
    "    res.writeHead(200, { 'content-type': 'text/plain' });",
    "    res.end('wall-open-A');",
    "    return;",
    "  }",
    "  res.writeHead(404);",
    "  res.end();",
    "}).listen(port, '127.0.0.1');",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(appRoot, "test", "platform.test.js"), [
    "const { test } = require('node:test');",
    "test('fixture boots', () => {});",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(binDir, "npm.cmd"), [
    "@echo off",
    "if /I \"%~1\"==\"ci\" (",
    "  if not exist node_modules\\electron\\dist mkdir node_modules\\electron\\dist",
    "  echo dist\\electron.exe> node_modules\\electron\\path.txt",
    "  echo electron-binary> node_modules\\electron\\dist\\electron.exe",
    "  exit /b 0",
    ")",
    "echo unexpected npm %*>&2",
    "exit /b 1",
    "",
  ].join("\r\n"), "utf8");
  git(appRoot, ["init", "-b", "main"]);
  git(appRoot, ["config", "user.email", "ci@example.com"]);
  git(appRoot, ["config", "user.name", "CI"]);
  git(base, ["init", "--bare", "-b", "main", origin]);
  git(appRoot, ["remote", "add", "origin", origin]);
  git(appRoot, ["add", "."]);
  git(appRoot, ["commit", "-m", "A"]);
  git(appRoot, ["push", "-u", "origin", "main"]);
  const server = fs.readFileSync(path.join(appRoot, "src", "server.js"), "utf8").replace("wall-open-A", "wall-open-B");
  fs.writeFileSync(path.join(appRoot, "src", "server.js"), server, "utf8");
  git(appRoot, ["commit", "-am", "B"]);
  git(appRoot, ["push", "origin", "main"]);
  git(appRoot, ["reset", "--hard", "HEAD~1"]);
  const zero = path.join(appRoot, "node_modules", "sharp", "index.js");
  fs.mkdirSync(path.dirname(zero), { recursive: true });
  fs.writeFileSync(zero, Buffer.alloc(128, 0));
}

function runBoot() {
  const env = {
    ...process.env,
    PATH: `${binDir};${process.env.PATH || ""}`,
    PINBALL_DATA_DIR: dataDir,
    PINBALL_APP_ROOT: appRoot,
    PINBALL_DNS_FILE: dnsFile,
    PINBALL_DNS_TIMEOUT_SEC: "90",
    PINBALL_WALL_PAUSE_SEC: "1",
  };
  delete env.PINBALL_UPDATE_OFFLINE;
  delete env.PINBALL_UPDATE_SMOKE;
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "invoke-update.ps1"),
      "-Mode",
      "boot",
    ], { env, windowsHide: true, cwd: base });
    let stdout = "";
    let stderr = "";
    let opened = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const logFile = path.join(dataDir, "logs", "update.log");
    const timer = setInterval(() => {
      if (opened) return;
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      if (log.includes("waiting for github.com")) {
        opened = true;
        fs.writeFileSync(dnsFile, "ready\n");
      }
    }, 200);
    const killTimer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true, opened });
    }, 180000);
    child.on("exit", (code) => {
      clearInterval(timer);
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut: false, opened });
    });
  });
}

async function readDisplay() {
  const deadline = Date.now() + 15000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/display/1`);
      last = await res.text();
      if (res.ok && last.includes("wall-open-B")) return last;
    } catch (err) {
      last = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`wall did not serve the updated page: ${last}`);
}

async function main() {
  cleanup();
  try {
    buildFixture();
    const created = registerTasks();
    if (created.status !== 0) {
      fail(`Could not register the wall tasks.\n${created.stdout || ""}\n${created.stderr || ""}`);
      return;
    }
    console.log(String(created.stdout || "").trim());
    const boot = await runBoot();
    const logFile = path.join(dataDir, "logs", "update.log");
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    if (boot.timedOut || boot.code !== 0) {
      fail(`Boot script did not finish (code ${boot.code}).\n${boot.stdout || ""}\n${boot.stderr || ""}\n${log}`);
      return;
    }
    if (!boot.opened) {
      fail(`Network delay was not observed.\n${log}`);
      return;
    }
    try {
      orderOf(log, [
        "phase dns-wait",
        "waiting for github.com",
        "github.com resolves",
        "phase update-plan",
        "result=update-available",
        "update available",
        "phase update-apply",
        "result=updated",
        "phase integrity",
        "install integrity ok",
        "phase wall-server",
        "phase wall-kiosk",
        "server and kiosk started",
      ]);
    } catch (err) {
      fail(err.message);
      return;
    }
    const zero = path.join(appRoot, "node_modules", "sharp", "index.js");
    if (fs.existsSync(zero)) {
      fail("The zero-filled file is still in the live install.");
      return;
    }
    const page = fs.readFileSync(path.join(appRoot, "src", "server.js"), "utf8");
    if (!page.includes("wall-open-B")) {
      fail("The live install is not the updated commit.");
      return;
    }
    const status = JSON.parse(fs.readFileSync(path.join(dataDir, "logs", "update-status.json"), "utf8"));
    if (status.action !== "updated" || status.integrityOk !== true) {
      fail(`Unexpected update status ${JSON.stringify(status)}`);
      return;
    }
    const body = await readDisplay();
    if (!body.includes("wall-open-B")) {
      fail(`Wall page was ${body}`);
      return;
    }
    const kiosk = fs.existsSync(kioskFile) ? fs.readFileSync(kioskFile, "utf8") : "";
    if (!kiosk.includes("fullscreen kiosk")) {
      fail(`Kiosk task did not open.\n${kiosk}`);
      return;
    }
    console.log("Cold boot waited for the network, installed the update, repaired the corrupt tree, and opened the wall.");
  } catch (err) {
    fail(err && err.stack ? err.stack : String(err));
  } finally {
    cleanup();
  }
}

main();
