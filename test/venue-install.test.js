const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const {
  findNestedUxplay,
  mergeUxplayArguments,
  uxplayArgumentPaths,
  writeUxplayArguments,
  airplayBackoffMs,
  AirplayController,
} = require("../src/airplay");

const root = path.join(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("uxplay lookup prefers the tray exe and skips the beacon", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinball-uxplay-"));
  fs.writeFileSync(path.join(dir, "uxplay-bluetooth-beacon.exe"), "");
  fs.writeFileSync(path.join(dir, "uxplay-windows-arm64.exe"), "");
  fs.writeFileSync(path.join(dir, "uxplay.exe"), "");
  fs.writeFileSync(path.join(dir, "uxplay-windows.exe"), "");
  fs.writeFileSync(path.join(dir, "mDNSResponder.exe"), "");
  const found = findNestedUxplay(dir, fs.existsSync);
  assert.match(found, /uxplay-windows\.exe$/);
  assert.doesNotMatch(found, /beacon|arm64/);
});

test("uxplay arguments name the receiver Pinball Land and keep other flags", () => {
  assert.equal(mergeUxplayArguments("-n uxplay-windows -nh -foo"), '-n "Pinball Land" -nh -foo');
  assert.equal(mergeUxplayArguments(""), '-n "Pinball Land" -nh');
  assert.doesNotMatch(mergeUxplayArguments("-n uxplay-windows -nh"), /-ble/);
  const paths = uxplayArgumentPaths({
    PROGRAMDATA: "C:\\ProgramData",
    APPDATA: "C:\\Users\\a\\AppData\\Roaming",
  });
  assert.equal(paths.length, 2);
  assert.match(paths[0], /uxplay-windows[\\/]arguments\.txt$/);
  assert.match(paths[1], /leapbtw[\\/]uxplay-windows[\\/]arguments\.txt$/);

  const files = new Map();
  const fsImpl = {
    readFileSync(file) {
      if (!files.has(file)) {
        const err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(file);
    },
    mkdirSync() {},
    writeFileSync(file, body) {
      files.set(file, body);
    },
  };
  files.set(paths[0], '-n uxplay-windows -nh -dacp\n');
  const written = writeUxplayArguments({
    platform: "win32",
    env: { PROGRAMDATA: "C:\\ProgramData", APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
    fsImpl,
    windowTitle: "Pinball Land",
  });
  assert.deepEqual(written, paths);
  assert.match(files.get(paths[0]), /^-n "Pinball Land" -nh -dacp/);
  assert.doesNotMatch(files.get(paths[0]), /uxplay-windows/);
  assert.match(files.get(paths[1]), /^-n "Pinball Land" -nh\n?$/);
});

test("a locked ProgramData arguments file does not throw, and UxPlay backs off", () => {
  const files = new Map();
  const fsImpl = {
    readFileSync(file) {
      if (!files.has(file)) {
        const err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(file);
    },
    mkdirSync() {},
    writeFileSync(file, body) {
      if (String(file).includes("ProgramData")) {
        const err = new Error("operation not permitted");
        err.code = "EPERM";
        throw err;
      }
      files.set(file, body);
    },
  };
  const written = writeUxplayArguments({
    platform: "win32",
    env: { PROGRAMDATA: "C:\\ProgramData", APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
    fsImpl,
  });
  assert.equal(written.length, 1);
  assert.match(written[0], /AppData/);
  assert.equal(written.denied.length, 1);
  assert.equal(airplayBackoffMs(0), 5000);
  assert.equal(airplayBackoffMs(1), 10000);
  assert.equal(airplayBackoffMs(8), 60000);

  let spawned = 0;
  const controller = new AirplayController({
    platform: "win32",
    root: "C:\\pinball-land",
    exists: () => true,
    alreadyRunning: () => false,
    getAirplayConfig: () => ({
      command: "C:\\pinball-land\\tools\\uxplay-windows\\uxplay-windows.exe",
    }),
    spawnImpl() {
      spawned += 1;
      const child = new EventEmitter();
      child.pid = 7;
      return child;
    },
  });
  controller.rememberArguments = () => false;
  const blocked = controller.ensureRunning();
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /arguments/);
  assert.equal(spawned, 0);
  assert.ok(controller.argumentBackoffUntil > Date.now());
  const again = controller.ensureRunning();
  assert.match(again.error, /backing off/);
  assert.equal(spawned, 0);
});

test("ensureRunning does not spawn when uxplay is already running", () => {
  let spawned = 0;
  const controller = new AirplayController({
    platform: "win32",
    root: "C:\\pinball-land",
    exists: () => true,
    alreadyRunning: () => true,
    getAirplayConfig: () => ({
      command: "C:\\pinball-land\\tools\\uxplay-windows\\uxplay-windows.exe",
      args: [],
      windowTitle: "Pinball Land",
    }),
    spawnImpl() {
      spawned += 1;
      const child = new EventEmitter();
      child.pid = 42;
      return child;
    },
  });
  const result = controller.ensureRunning();
  assert.equal(result.ok, true);
  assert.equal(result.already, true);
  assert.equal(result.external, true);
  assert.equal(spawned, 0);
  const started = controller.start({ slot: "1" });
  assert.equal(started.already, true);
  assert.equal(spawned, 0);
});

test("the kiosk does not spawn UxPlay; the server starts one receiver", () => {
  const kiosk = read("src/kiosk.js");
  const server = read("src/app.js");
  assert.doesNotMatch(kiosk, /ensureRunning/);
  assert.doesNotMatch(kiosk, /AirplayController/);
  assert.match(kiosk, /does not spawn/);
  assert.match(server, /already running/);
  assert.match(server, /ensureRunning/);
});

test("RustDesk install waits on the installer pid and still installs the service", () => {
  const script = read("scripts/install-remote-support.ps1");
  assert.doesNotMatch(script, /Start-Process/);
  assert.match(script, /WaitForExit/);
  assert.match(script, /within 120 seconds/);
  assert.match(script, /--install-service/);
  assert.match(script, /StartupType Automatic/);
  assert.match(script, /--password/);
  assert.match(script, /--get-id/);
  assert.match(script, /RustDesk ID:/);
  assert.match(script, /Dry run: RustDesk will not be downloaded/);
});

test("airplay install prefers uxplay-windows, names Pinball Land, and tolerates Bonjour 1603", () => {
  const script = read("scripts/install-airplay-windows.ps1");
  assert.match(script, /uxplay-windows\.exe/);
  assert.match(script, /beacon\|arm64/);
  assert.match(script, /arguments\.txt/);
  assert.match(script, /Pinball Land/);
  assert.match(script, /leapbtw\\uxplay-windows/);
  assert.match(script, /1603/);
  assert.match(script, /mDNSResponder/);
  assert.match(script, /9d3a51c15fc9db857351195e7eb7bbb21700d9ae25d936a54bcf8536b62cca18/);
  assert.match(script, /7f1ec347cd429cfb25a34b2147e02231334f28290e0c28be213415b0f99da1a0/);
  assert.doesNotMatch(script, /uxplay-windows-arm64/);
});

test("Funnel not enabled exits nonzero and tells the operator to re-run", () => {
  const script = read("scripts/enable-public-access.ps1");
  assert.match(script, /Funnel is not enabled/);
  assert.match(script, /exit 1/);
  assert.match(script, /re-run this script/);
  assert.match(script, /funnel --bg/);
});

test("kiosk setup installs Google Chrome and verify warns only on a dry run", () => {
  const chrome = read("scripts/install-chrome.ps1");
  const beelink = read("scripts/install-beelink.ps1");
  const kiosk = read("scripts/install-kiosk-windows.ps1");
  const launcher = read("scripts/open-wall-chrome.ps1");
  assert.match(chrome, /Google\.Chrome/);
  assert.match(chrome, /GoogleChromeStandaloneEnterprise64\.msi/);
  assert.match(chrome, /LOCALAPPDATA/);
  assert.match(chrome, /Dry run: would install Google Chrome/);
  assert.match(beelink, /Install-PinballChrome -DryRun:\$DryRun/);
  assert.match(kiosk, /Install-PinballChrome -DryRun:\$DryRun/);
  assert.match(kiosk, /Google Chrome/);
  assert.match(kiosk, /winget install Google\.Chrome runs when this is not a dry run/);
  assert.match(launcher, /LOCALAPPDATA/);
  assert.match(launcher, /msedge\.exe/);
  assert.match(launcher, /Google Chrome and Microsoft Edge were not found/);
});
