const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { wallChromeArgs, chromeProfileDir, ownsDisplayProfile, relaunchWallChrome, launchPlan, findChrome } = require("../src/wall-chrome");

test("each display gets its own Chrome profile and decode flags", () => {
  const profile = chromeProfileDir(path.join("C:", "ProgramData", "PinballLand"), 2);
  assert.match(profile, /chrome[\\/]display2$/);
  const args = wallChromeArgs({
    url: "http://127.0.0.1:3000/display/2",
    profile,
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    softwareDecode: true,
  });
  assert.ok(args.some((arg) => arg === `--user-data-dir=${profile}`));
  assert.ok(args.includes("--kiosk"));
  assert.ok(args.includes("--autoplay-policy=no-user-gesture-required"));
  assert.ok(args.includes("--disable-background-timer-throttling"));
  assert.ok(args.includes("--disable-renderer-backgrounding"));
  assert.ok(args.includes("--disable-backgrounding-occluded-windows"));
  assert.ok(args.includes("--disable-background-media-suspend"));
  assert.ok(args.some((arg) => arg.includes("CalculateNativeWinOcclusion")));
  assert.ok(args.includes("--disable-gpu-video-decode"));
  assert.ok(args.includes("--disable-accelerated-video-decode"));
  assert.ok(args.some((arg) => arg.startsWith("--window-position=10,20")));
  const plain = wallChromeArgs({ url: "http://localhost:3000/display/1", profile, softwareDecode: false, kiosk: false });
  assert.equal(plain.includes("--kiosk"), false);
  assert.equal(plain.includes("--disable-gpu-video-decode"), false);
  assert.equal(ownsDisplayProfile(`google-chrome --user-data-dir=${profile} --app=http://127.0.0.1/display/2`, path.join("C:", "ProgramData", "PinballLand")), true);
  assert.equal(ownsDisplayProfile("google-chrome --user-data-dir=/home/adam/.config/google-chrome", path.join("C:", "ProgramData", "PinballLand")), false);
});

test("opening one missing display leaves the running displays alone", () => {
  const added = launchPlan({
    saved: [{ slot: 1, pid: 11 }, { slot: 2, pid: 22 }],
    requested: [{ slot: 3 }],
    killExisting: false,
    runningSlots: [1, 2],
  });
  assert.deepEqual(added.spawn, [3]);
  assert.deepEqual(added.keep, []);
  assert.deepEqual(added.untouched, [1, 2]);
  const again = launchPlan({
    saved: [{ slot: 1, pid: 11 }, { slot: 2, pid: 22 }],
    requested: [{ slot: 1 }, { slot: 2 }],
    killExisting: false,
    runningSlots: [1, 2],
  });
  assert.deepEqual(again.spawn, []);
  assert.deepEqual(again.keep, [1, 2]);
  assert.deepEqual(again.untouched, []);
});

test("per-user Chrome is used before Edge, and Edge before Electron", () => {
  const env = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\venue\\AppData\\Local",
  };
  const localChrome = path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
  assert.equal(findChrome({
    platform: "win32",
    env,
    exists: (candidate) => candidate === localChrome,
  }), localChrome);
  const edge = path.join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe");
  assert.equal(findChrome({
    platform: "win32",
    env,
    exists: (candidate) => candidate === edge,
  }), edge);
  assert.equal(findChrome({
    platform: "win32",
    env: { ...env, PINBALL_CHROME: "/opt/chrome" },
    exists: (candidate) => candidate === "/opt/chrome",
  }), "/opt/chrome");
  assert.equal(findChrome({ platform: "win32", env, exists: () => false }), "");
});

test("unit tests do not relaunch Chrome", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pinball-chrome-"));
  const result = await relaunchWallChrome({ dataDir: dir, softwareDecode: true });
  assert.equal(result.skipped, "test");
});
