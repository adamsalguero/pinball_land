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

const repo = path.join(__dirname, "..");
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

function sharpStub() {
  return [
    "function sharp() {",
    "  const api = {",
    "    rotate() { return api; },",
    "    resize() { return api; },",
    "    jpeg() { return api; },",
    "    metadata: async () => ({ width: 320, height: 240 }),",
    "    toBuffer: async () => ({ data: Buffer.from([255, 216, 255, 217]), info: { width: 320, height: 240 } }),",
    "  };",
    "  return api;",
    "}",
    "module.exports = sharp;",
    "",
  ].join("\n");
}

function killFixtureProcesses() {
  spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'pl-boot-order' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ], { windowsHide: true, timeout: 20000 });
}

function cleanup() {
  for (const name of [serverTask, kioskTask, "PinballLandUpdateRetry"]) {
    schtasks(["/End", "/TN", name]);
    schtasks(["/Delete", "/TN", name, "/F"]);
  }
  killFixtureProcesses();
}

function installRuntime(appRoot, binDir) {
  const exe = "electron.exe";
  fs.mkdirSync(path.join(appRoot, "node_modules", "electron", "dist"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "node_modules", "sharp"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "node_modules", "electron", "path.txt"), `dist/${exe}\n`);
  fs.writeFileSync(path.join(appRoot, "node_modules", "electron", "dist", exe), "electron-binary");
  fs.copyFileSync(path.join(binDir, "sharp-stub.js"), path.join(appRoot, "node_modules", "sharp", "index.js"));
  fs.writeFileSync(path.join(appRoot, "node_modules", "sharp", "package.json"), "{\"name\":\"sharp\",\"version\":\"0.0.0\"}\n");
}

function buildFixture(ctx) {
  fs.rmSync(ctx.base, { recursive: true, force: true });
  fs.mkdirSync(ctx.appRoot, { recursive: true });
  fs.mkdirSync(path.join(ctx.appRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(ctx.appRoot, "test"), { recursive: true });
  fs.mkdirSync(ctx.binDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.binDir, "sharp-stub.js"), sharpStub(), "utf8");
  fs.writeFileSync(path.join(ctx.binDir, "sharp-package.json"), "{\"name\":\"sharp\",\"version\":\"0.0.0\"}\n", "utf8");
  fs.writeFileSync(path.join(ctx.binDir, "npm.cmd"), [
    "@echo off",
    "if /I \"%~1\"==\"ci\" (",
    "  if not exist node_modules\\electron\\dist mkdir node_modules\\electron\\dist",
    "  if not exist node_modules\\sharp mkdir node_modules\\sharp",
    "  echo dist\\electron.exe> node_modules\\electron\\path.txt",
    "  echo electron-binary> node_modules\\electron\\dist\\electron.exe",
    "  copy /Y \"%~dp0sharp-stub.js\" node_modules\\sharp\\index.js >nul",
    "  copy /Y \"%~dp0sharp-package.json\" node_modules\\sharp\\package.json >nul",
    "  exit /b 0",
    ")",
    "echo unexpected npm %*>&2",
    "exit /b 1",
    "",
  ].join("\r\n"), "utf8");
  fs.writeFileSync(path.join(ctx.appRoot, ".gitignore"), "node_modules\n", "utf8");
  fs.writeFileSync(path.join(ctx.appRoot, "package.json"), `${JSON.stringify({
    name: "pinball-boot-fixture",
    private: true,
    version: "1.0.0",
    dependencies: { sharp: "0.0.0" },
  })}\n`, "utf8");
  for (const name of ["photos.js", "resolution.js", "text-filter.js"]) {
    fs.copyFileSync(path.join(repo, "src", name), path.join(ctx.appRoot, "src", name));
  }
  fs.writeFileSync(path.join(ctx.appRoot, "src", "server.js"), [
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
  fs.writeFileSync(path.join(ctx.appRoot, "test", "platform.test.js"), [
    "const { test } = require('node:test');",
    "test('fixture boots', () => {});",
    "",
  ].join("\n"), "utf8");
  git(ctx.appRoot, ["init", "-b", "main"]);
  git(ctx.appRoot, ["config", "user.email", "ci@example.com"]);
  git(ctx.appRoot, ["config", "user.name", "CI"]);
  git(ctx.base, ["init", "--bare", "-b", "main", ctx.origin]);
  git(ctx.appRoot, ["remote", "add", "origin", ctx.origin]);
  git(ctx.appRoot, ["add", "."]);
  git(ctx.appRoot, ["commit", "-m", "A"]);
  git(ctx.appRoot, ["push", "-u", "origin", "main"]);
  if (ctx.update) {
    const server = fs.readFileSync(path.join(ctx.appRoot, "src", "server.js"), "utf8").replace("wall-open-A", "wall-open-B");
    fs.writeFileSync(path.join(ctx.appRoot, "src", "server.js"), server, "utf8");
    git(ctx.appRoot, ["commit", "-am", "B"]);
    git(ctx.appRoot, ["push", "origin", "main"]);
    git(ctx.appRoot, ["reset", "--hard", "HEAD~1"]);
  }
  installRuntime(ctx.appRoot, ctx.binDir);
  if (ctx.corrupt) {
    fs.writeFileSync(path.join(ctx.appRoot, "node_modules", "electron", "path.txt"), Buffer.alloc(64, 0));
  }
}

function registerTasks(ctx) {
  const serverPs1 = path.join(ctx.base, "wall-server.ps1");
  const kioskPs1 = path.join(ctx.base, "wall-kiosk.ps1");
  const registerPs1 = path.join(ctx.base, "register-wall.ps1");
  fs.writeFileSync(serverPs1, [
    "$ErrorActionPreference = 'Continue'",
    `$env:PORT = '${ctx.port}'`,
    `& ${psQuote(process.execPath)} ${psQuote(path.join(ctx.appRoot, "src", "server.js"))}`,
    "",
  ].join("\r\n"), "utf8");
  fs.writeFileSync(kioskPs1, [
    "$ErrorActionPreference = 'Continue'",
    `$dir = Split-Path -Parent ${psQuote(ctx.kioskFile)}`,
    "if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }",
    `Add-Content -LiteralPath ${psQuote(ctx.kioskFile)} -Value 'fullscreen kiosk' -Encoding UTF8`,
    "while ($true) { Start-Sleep -Seconds 5 }",
    "",
  ].join("\r\n"), "utf8");
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$user = $env:USERNAME",
  ];
  for (const [name, file] of [[serverTask, serverPs1], [kioskTask, kioskPs1]]) {
    const taskFile = String(file).replace(/"/g, "");
    lines.push(`$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"${taskFile}\`""`);
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

function runBoot(ctx) {
  const env = {
    ...process.env,
    PATH: `${ctx.binDir};${process.env.PATH || ""}`,
    PINBALL_DATA_DIR: ctx.dataDir,
    PINBALL_APP_ROOT: ctx.appRoot,
    PINBALL_DNS_FILE: ctx.dnsFile,
    PINBALL_DNS_TIMEOUT_SEC: String(ctx.dnsTimeout),
    PINBALL_WALL_PAUSE_SEC: "0",
  };
  delete env.PINBALL_UPDATE_OFFLINE;
  delete env.PINBALL_UPDATE_SMOKE;
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repo, "scripts", "invoke-update.ps1"),
      "-Mode",
      "boot",
    ], { env, windowsHide: true, cwd: ctx.base });
    let stdout = "";
    let stderr = "";
    const seen = [];
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setInterval(async () => {
      const log = fs.existsSync(ctx.logFile) ? fs.readFileSync(ctx.logFile, "utf8") : "";
      if (ctx.releaseDns && !fs.existsSync(ctx.dnsFile) && log.includes("waiting for github.com")) {
        fs.writeFileSync(ctx.dnsFile, "ready\n");
      }
      if (!ctx.sawPage) {
        try {
          const res = await fetch(`http://127.0.0.1:${ctx.port}/display/1`);
          const body = await res.text();
          if (res.ok && body.includes("wall-open-")) {
            seen.push(body.trim());
            ctx.sawPage = body;
          }
        } catch {
          // The server is not listening yet.
        }
      }
    }, 150);
    const killTimer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true, seen });
    }, ctx.killAfter);
    child.on("exit", (code) => {
      clearInterval(timer);
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut: false, seen });
    });
  });
}

function wallMs(log) {
  const match = log.match(/wall open at (\d+)ms/);
  return match ? Number(match[1]) : null;
}

function zeroMs(log) {
  const match = log.match(/zero-scan (\d+)ms/);
  return match ? Number(match[1]) : null;
}

async function scenario(spec) {
  const base = path.join("C:\\pl-boot-order", spec.name);
  const ctx = {
    ...spec,
    base,
    appRoot: path.join(base, "app"),
    origin: path.join(base, "origin.git"),
    dataDir: path.join(base, "data"),
    binDir: path.join(base, "bin"),
    dnsFile: path.join(base, "dns-ready"),
    kioskFile: path.join(base, "data", "kiosk-opened.txt"),
    logFile: path.join(base, "data", "logs", "update.log"),
    sawPage: "",
  };
  cleanup();
  buildFixture(ctx);
  const created = registerTasks(ctx);
  if (created.status !== 0) {
    throw new Error(`Could not register the wall tasks.\n${created.stdout || ""}\n${created.stderr || ""}`);
  }
  const boot = await runBoot(ctx);
  const log = fs.existsSync(ctx.logFile) ? fs.readFileSync(ctx.logFile, "utf8") : "";
  if (boot.timedOut || boot.code !== 0) {
    throw new Error(`Boot script did not finish (code ${boot.code}).\n${boot.stdout || ""}\n${boot.stderr || ""}\n${log}`);
  }
  orderOf(log, spec.order);
  const opened = wallMs(log);
  const scanned = zeroMs(log);
  if (opened === null || scanned === null) throw new Error(`missing timings\n${log}`);
  if (spec.maxWallMs && opened > spec.maxWallMs) {
    throw new Error(`${spec.name} reached the wall in ${opened}ms, above ${spec.maxWallMs}ms\n${log}`);
  }
  const kiosk = fs.existsSync(ctx.kioskFile) ? fs.readFileSync(ctx.kioskFile, "utf8") : "";
  const starts = kiosk.split(/\r?\n/).filter((line) => line.includes("fullscreen kiosk")).length;
  if (starts !== 1) throw new Error(`${spec.name} started the kiosk ${starts} times\n${kiosk}\n${log}`);
  const kioskPhases = log.split("phase wall-kiosk").length - 1;
  if (kioskPhases !== 1) throw new Error(`${spec.name} logged phase wall-kiosk ${kioskPhases} times\n${log}`);
  if (spec.page) {
    const deadline = Date.now() + 10000;
    let body = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/display/1`);
        body = await res.text();
        if (body.includes(spec.page)) break;
      } catch (err) {
        body = err.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!body.includes(spec.page)) throw new Error(`${spec.name} page was ${body}`);
  }
  if (spec.sawFirst && !boot.seen.some((line) => String(line).includes(spec.sawFirst))) {
    throw new Error(`${spec.name} never served ${spec.sawFirst} before the swap; saw ${boot.seen.join(", ") || "nothing"}`);
  }
  if (spec.serverOnly && !log.includes("restarted the server only")) {
    throw new Error(`${spec.name} restarted more than the server\n${log}`);
  }
  if (spec.serverOnly && log.includes("kiosk was dead")) {
    throw new Error(`${spec.name} restarted the kiosk windows\n${log}`);
  }
  if (spec.corrupt) {
    const pathFile = path.join(ctx.appRoot, "node_modules", "electron", "path.txt");
    const bytes = fs.readFileSync(pathFile);
    if (bytes.length && bytes.every((byte) => byte === 0)) {
      throw new Error("electron path.txt is still zero-filled");
    }
  }
  return { name: spec.name, opened, scanned, log };
}

async function main() {
  cleanup();
  const results = [];
  try {
    results.push(await scenario({
      name: "healthy",
      port: 18766,
      dnsTimeout: 4,
      killAfter: 60000,
      maxWallMs: 15000,
      releaseDns: false,
      update: false,
      corrupt: false,
      page: "wall-open-A",
      order: [
        "phase quick-check",
        "quick check ok",
        "phase wall-server",
        "phase wall-kiosk",
        "wall open at",
        "phase zero-scan",
        "phase upload-check",
        "upload check ok",
        "phase dns-wait",
        "waiting for github.com",
        "phase update-skip",
        "network unavailable; skipping the update",
      ],
    }));
    results.push(await scenario({
      name: "update",
      port: 18767,
      dnsTimeout: 30,
      killAfter: 180000,
      maxWallMs: 15000,
      releaseDns: true,
      update: true,
      corrupt: false,
      page: "wall-open-B",
      sawFirst: "wall-open-A",
      serverOnly: true,
      order: [
        "phase quick-check",
        "quick check ok",
        "phase wall-server",
        "wall open at",
        "phase upload-check",
        "upload check ok",
        "phase dns-wait",
        "waiting for github.com",
        "github.com resolves",
        "phase update-plan",
        "update available",
        "phase update-stage",
        "phase update-swap",
        "restarted the server only",
      ],
    }));
    results.push(await scenario({
      name: "repair",
      port: 18768,
      dnsTimeout: 4,
      killAfter: 180000,
      releaseDns: false,
      update: false,
      corrupt: true,
      page: "wall-open-A",
      order: [
        "phase quick-check",
        "quick check failed; repairing before the wall",
        "phase wall-server",
        "wall open at",
        "phase zero-scan",
        "phase upload-check",
        "upload check ok",
        "phase dns-wait",
      ],
    }));
    for (const result of results) {
      console.log(`${result.name}: wall open at ${result.opened}ms; full zero-scan ${result.scanned}ms`);
    }
    console.log("Healthy boot opens the wall before DNS. A background update restarts only the server. A failed quick check repairs before the wall.");
    console.log("The zero-scan figure is this small fixture. A full node_modules walk on the venue SER5 was about 66s, which is why it stays behind the open wall.");
  } catch (err) {
    for (const result of results) {
      console.log(`${result.name}: wall open at ${result.opened}ms; full zero-scan ${result.scanned}ms`);
    }
    fail(err && err.stack ? err.stack : String(err));
  } finally {
    cleanup();
  }
}

main();
