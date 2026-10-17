const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { resolveDataDir, isKioskInstall, icaclsRepairCommand } = require("../src/paths");

function locked(code) {
  return Object.assign(new Error(code), { code });
}

const homeEnv = {
  PROGRAMDATA: "C:\\ProgramData",
  LOCALAPPDATA: "C:\\Users\\Adam\\AppData\\Local",
};

test("an explicit data dir is used even when ProgramData is not writable", async () => {
  let probed = false;
  const dir = await resolveDataDir({
    env: { ...homeEnv, PINBALL_DATA_DIR: path.join(__dirname, "fixture-data") },
    platform: "win32",
    kioskInstalled: false,
    fsImpl: {
      async mkdir() {
        probed = true;
        throw locked("EPERM");
      },
    },
    log() {
      throw new Error("explicit data dir should not log a fallback");
    },
  });
  assert.equal(probed, false);
  assert.equal(dir, path.resolve(path.join(__dirname, "fixture-data")));
});

test("home startup falls back to LocalAppData when ProgramData is EPERM", async () => {
  const logs = [];
  const dir = await resolveDataDir({
    env: homeEnv,
    platform: "win32",
    homedir: "C:\\Users\\Adam",
    kioskInstalled: false,
    fsImpl: {
      async mkdir() {
        throw locked("EPERM");
      },
      async open() {
        throw locked("EPERM");
      },
    },
    log: (line) => logs.push(line),
  });
  assert.equal(dir, "C:\\Users\\Adam\\AppData\\Local\\PinballLand");
  const text = logs.join("\n");
  assert.match(text, /PINBALL LAND DATA DIRECTORY/);
  assert.match(text, /not the kiosk install/);
  assert.match(text, /%LOCALAPPDATA%\\PinballLand/);
  assert.match(text, /EPERM/);
  assert.ok(text.includes(icaclsRepairCommand("C:\\ProgramData\\PinballLand")));
  assert.ok(text.includes('icacls "C:\\ProgramData\\PinballLand" /grant "Users:(OI)(CI)M" /T /C'));
});

test("a writable ProgramData folder stays the data dir", async () => {
  const dir = await resolveDataDir({
    env: homeEnv,
    platform: "win32",
    kioskInstalled: false,
    fsImpl: {
      async mkdir() {},
      async open() {
        return {
          async writeFile() {},
          async sync() {},
          async close() {},
        };
      },
      async unlink() {},
    },
    log() {
      throw new Error("writable ProgramData should not fall back");
    },
  });
  assert.equal(dir, "C:\\ProgramData\\PinballLand");
});

test("the kiosk install keeps ProgramData when it is not writable", async () => {
  const logs = [];
  const dir = await resolveDataDir({
    env: { ...homeEnv, PINBALL_KIOSK: "1" },
    platform: "win32",
    kioskInstalled: false,
    fsImpl: {
      async mkdir() {
        throw locked("EPERM");
      },
    },
    log: (line) => logs.push(line),
  });
  assert.equal(dir, "C:\\ProgramData\\PinballLand");
  assert.deepEqual(logs, []);
  assert.equal(isKioskInstall({ npm_lifecycle_event: "kiosk" }), true);
  assert.equal(isKioskInstall({ npm_lifecycle_event: "start" }), false);
});

test("an installed kiosk task keeps ProgramData for npm start", async () => {
  const dir = await resolveDataDir({
    env: { ...homeEnv, npm_lifecycle_event: "start" },
    platform: "win32",
    kioskInstalled: true,
    fsImpl: {
      async mkdir() {
        throw locked("EACCES");
      },
    },
    log() {
      throw new Error("kiosk install must not switch data dirs");
    },
  });
  assert.equal(dir, "C:\\ProgramData\\PinballLand");
});

test("non-windows startup stays in the home directory", async () => {
  let probed = false;
  const dir = await resolveDataDir({
    env: homeEnv,
    platform: "linux",
    homedir: "/home/adam",
    fsImpl: {
      async mkdir() {
        probed = true;
        throw locked("EPERM");
      },
    },
  });
  assert.equal(probed, false);
  assert.equal(dir, "/home/adam/.pinball-land");
});
