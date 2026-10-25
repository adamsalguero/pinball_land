const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { normalizeUpdates } = require("../src/config");
const {
  appendUpdateLog,
  invokeNowCompleted,
  invokeNowStarted,
  launchScheduledUpdate,
  repairInstall,
  runSelfUpdate,
  verifyRuntimeDeps,
} = require("../src/self-update");
const { scanInstall, stagePaths, writeMarker } = require("../src/install-guard");
const { GuestAlbum } = require("../src/photos");

const HEAD = "aaaaaaaa";
const NEXT = "bbbbbbbb";

function ok(stdout) {
  return { ok: true, code: 0, stdout, stderr: "", timedOut: false };
}

function fail(stderr) {
  return { ok: false, code: 1, stdout: "", stderr, timedOut: false };
}

async function setup() {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-app-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-data-"));
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  await fs.mkdir(path.join(appRoot, "node_modules", "electron", "dist"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "node_modules", "electron", "path.txt"), `dist/${exe}\n`);
  await fs.writeFile(path.join(appRoot, "node_modules", "electron", "dist", exe), "electron-binary");
  const kept = {
    state: path.join(dataDir, "state.json"),
    config: path.join(dataDir, "config.json"),
    photo: path.join(dataDir, "guest-photos", "a.jpg"),
    media: path.join(dataDir, "media", "library", "clip.txt"),
  };
  await fs.mkdir(path.dirname(kept.photo), { recursive: true });
  await fs.mkdir(path.dirname(kept.media), { recursive: true });
  await fs.writeFile(kept.state, "{\"scores\":true}\n");
  await fs.writeFile(kept.config, "{\"pin\":\"2224\",\"updates\":{\"nightlyAt\":\"03:17\"}}\n");
  await fs.writeFile(kept.photo, "photo-bytes");
  await fs.writeFile(kept.media, "media-bytes");
  await fs.writeFile(path.join(appRoot, "package.json"), `${JSON.stringify({ dependencies: { sharp: "0.33.5" } })}\n`);
  const before = {};
  for (const [key, file] of Object.entries(kept)) before[key] = await fs.readFile(file);
  return {
    appRoot,
    dataDir,
    async assertDataUntouched() {
      for (const [key, file] of Object.entries(kept)) {
        assert.deepEqual(await fs.readFile(file), before[key], key);
      }
    },
  };
}

function scripted({ ahead = "1", fetchMode = "ok", npmFailOn = 0, depFail = false } = {}) {
  const calls = [];
  let npmCalls = 0;
  async function run(command, args) {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return ok(`${HEAD}\n`);
    if (command === "git" && args[0] === "rev-parse") return ok(`${NEXT}\n`);
    if (command === "git" && args[0] === "fetch") {
      if (fetchMode === "timeout") return { ok: false, code: null, stdout: "", stderr: "timed out", timedOut: true };
      if (fetchMode === "fail") return fail("Could not resolve host");
      return ok("");
    }
    if (command === "git" && args[0] === "rev-list") return ok(`${ahead}\n`);
    if (command === "git" && args[0] === "reset") return ok("");
    if (command === "git" && args[0] === "clone") {
      const dest = args[args.length - 1];
      const exe = process.platform === "win32" ? "electron.exe" : "electron";
      await fs.mkdir(path.join(dest, "node_modules", "electron", "dist"), { recursive: true });
      await fs.mkdir(path.join(dest, "src"), { recursive: true });
      await fs.writeFile(path.join(dest, "package.json"), `${JSON.stringify({ dependencies: { sharp: "0.33.5" } })}\n`);
      await fs.writeFile(path.join(dest, "node_modules", "electron", "path.txt"), `dist/${exe}\n`);
      await fs.writeFile(path.join(dest, "node_modules", "electron", "dist", exe), "electron-binary");
      return ok("");
    }
    if (args[0] === "ci") {
      npmCalls += 1;
      if (npmFailOn && npmCalls <= npmFailOn) return fail("npm ci exploded");
      return ok("");
    }
    if (args[0] === "-e") {
      if (depFail) return fail("Invalid or unexpected token");
      return ok("");
    }
    return ok("");
  }
  return { run, calls, npmCount: () => npmCalls };
}

async function update(ctx, script, extra = {}) {
  return runSelfUpdate({
    appRoot: ctx.appRoot,
    dataDir: ctx.dataDir,
    mode: "boot",
    npmBin: "npm.cmd",
    run: script.run,
    smoke: async () => ({ ok: true, detail: "smoke ok" }),
    runTests: async () => ({ ok: true, detail: "unit tests passed" }),
    ...extra,
  });
}

test("nightly clock defaults to 03:17 and rejects a bad time", () => {
  assert.equal(normalizeUpdates(null).nightlyAt, "03:17");
  assert.equal(normalizeUpdates({ nightlyAt: "3:17" }).nightlyAt, "03:17");
  assert.equal(normalizeUpdates({ nightlyAt: "25:99" }).nightlyAt, "03:17");
  assert.equal(normalizeUpdates({ enabled: false }).enabled, false);
});

test("update log rotates after the size cap", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-log-"));
  await appendUpdateLog(dir, `${"x".repeat(80)}\n`, { maxBytes: 40 });
  await appendUpdateLog(dir, "next line\n", { maxBytes: 40 });
  const backup = await fs.readFile(path.join(dir, "update.log.1"), "utf8");
  const current = await fs.readFile(path.join(dir, "update.log"), "utf8");
  assert.match(backup, /x{80}/);
  assert.equal(current, "next line\n");
});

test("npm ci failure leaves the live install untouched and venue data alone", async () => {
  const ctx = await setup();
  const script = scripted({ npmFailOn: 2 });
  let smoked = false;
  const result = await update(ctx, script, {
    smoke: async () => {
      smoked = true;
      return { ok: true };
    },
  });
  assert.equal(result.action, "rolled-back");
  assert.equal(result.commit, HEAD);
  assert.equal(smoked, false);
  assert.equal(script.npmCount(), 2);
  assert.ok(script.calls.some((call) => call[0] === "npm.cmd" && call[1] === "ci" && call[2] === "--omit=dev"));
  assert.equal(script.calls.some((call) => call[1] === "reset"), false);
  assert.ok(script.calls.some((call) => call[1] === "clone"));
  const pointer = await fs.readFile(path.join(ctx.dataDir, "updates", "current.txt"), "utf8");
  assert.match(pointer, new RegExp(HEAD));
  const log = await fs.readFile(path.join(ctx.dataDir, "logs", "update.log"), "utf8");
  assert.match(log, /rolled-back/);
  assert.match(log, /npm ci failed/);
  await ctx.assertDataUntouched();
});

test("smoke check failure rolls back and installs the previous commit again", async () => {
  const ctx = await setup();
  const script = scripted();
  let tests = 0;
  const result = await update(ctx, script, {
    smoke: async () => ({ ok: false, detail: "health did not respond" }),
    runTests: async () => {
      tests += 1;
      return { ok: true };
    },
  });
  assert.equal(result.action, "rolled-back");
  assert.equal(result.commit, HEAD);
  assert.match(result.detail, /health did not respond/);
  assert.equal(tests, 0);
  assert.equal(script.npmCount(), 1);
  assert.equal(script.calls.some((call) => call[1] === "reset"), false);
  await ctx.assertDataUntouched();
});

test("a dead network skips the update and does not reset or reinstall", async () => {
  const ctx = await setup();
  const script = scripted({ fetchMode: "timeout" });
  const result = await update(ctx, script, {
    smoke: async () => {
      throw new Error("smoke should not run");
    },
  });
  assert.equal(result.action, "skipped");
  assert.match(result.detail, /timed out/);
  assert.equal(script.npmCount(), 0);
  assert.equal(script.calls.some((call) => call[1] === "reset"), false);
  await ctx.assertDataUntouched();
});

test("an equal main branch does not pull", async () => {
  const ctx = await setup();
  const script = scripted({ ahead: "0" });
  const calls = [];
  const result = await runSelfUpdate({
    appRoot: ctx.appRoot,
    dataDir: ctx.dataDir,
    mode: "nightly",
    npmBin: "npm.cmd",
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return ok(`${HEAD}\n`);
      if (command === "git" && args[0] === "rev-parse") return ok(`${HEAD}\n`);
      if (command === "git" && args[0] === "fetch") return ok("");
      if (command === "git" && args[0] === "rev-list") return ok("0\n");
      return ok("");
    },
    smoke: async () => {
      throw new Error("smoke should not run");
    },
    runTests: async () => {
      throw new Error("tests should not run");
    },
  });
  assert.equal(result.action, "up-to-date");
  assert.equal(result.commit, HEAD);
  assert.equal(calls.some((call) => call[1] === "reset" || call[1] === "ci"), false);
  void script;
  await ctx.assertDataUntouched();
});

test("a good update records the new commit and keeps venue data", async () => {
  const ctx = await setup();
  const script = scripted();
  const result = await update(ctx, script);
  assert.equal(result.action, "updated");
  assert.equal(result.commit, NEXT);
  assert.equal(result.previous, HEAD);
  assert.equal(script.npmCount(), 1);
  const pointer = await fs.readFile(path.join(ctx.dataDir, "updates", "current.txt"), "utf8");
  assert.match(pointer, new RegExp(NEXT));
  const previous = await fs.readFile(path.join(ctx.dataDir, "updates", "previous.txt"), "utf8");
  assert.match(previous, new RegExp(HEAD));
  await ctx.assertDataUntouched();
});

test("a runtime dependency that will not load reruns npm ci and rolls back", async () => {
  const ctx = await setup();
  const script = scripted({ depFail: true });
  const result = await update(ctx, script, {
    smoke: async () => {
      throw new Error("smoke should not run");
    },
  });
  assert.equal(result.action, "rolled-back");
  assert.match(result.detail, /runtime dependencies failed to load/);
  assert.match(result.detail, /Invalid or unexpected token/);
  assert.equal(script.calls.filter((call) => call[1] === "-e").length, 2);
  assert.equal(script.npmCount(), 2);
  await ctx.assertDataUntouched();
});

test("a zero-filled dependency file fails the runtime check", async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-sharp-"));
  const valid = path.join(appRoot, "node_modules", "sharp", "node_modules", "semver", "ranges", "valid.js");
  await fs.mkdir(path.dirname(valid), { recursive: true });
  await fs.writeFile(path.join(appRoot, "package.json"), `${JSON.stringify({ dependencies: { sharp: "0.33.5" } })}\n`);
  await fs.writeFile(path.join(appRoot, "node_modules", "sharp", "package.json"), `${JSON.stringify({ name: "sharp", version: "0.0.0" })}\n`);
  await fs.writeFile(path.join(appRoot, "node_modules", "sharp", "index.js"), "require('semver/ranges/valid');\nmodule.exports = function sharp() { return {}; };\n");
  await fs.writeFile(path.join(appRoot, "node_modules", "sharp", "node_modules", "semver", "package.json"), `${JSON.stringify({ name: "semver", version: "7.8.5" })}\n`);
  await fs.writeFile(valid, Buffer.alloc(326, 0));
  const result = await verifyRuntimeDeps(appRoot);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Invalid or unexpected token/);
});

test("update now logs the request before schtasks and ignores a requested line", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-now-"));
  const calls = [];
  const launched = launchScheduledUpdate({
    dataDir,
    mode: "now",
    platform: "win32",
    now: () => new Date("2026-10-25T06:00:00.000Z"),
    run(command, args) {
      calls.push([command, ...args]);
      return { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
    },
  });
  assert.equal(launched.started, false);
  assert.deepEqual(calls, [["schtasks.exe", "/Run", "/TN", "PinballLandUpdateNow"]]);
  const log = await fs.readFile(path.join(dataDir, "logs", "update.log"), "utf8");
  assert.match(log, /\[2026-10-25T06:00:00.000Z\] invoke now requested/);
  assert.match(log, /invoke now not started/);
  assert.equal(invokeNowStarted(log, launched.requestedAt), false);
  const started = `${log}[2026-10-25T06:00:01.000Z] invoke now start\n`;
  assert.equal(invokeNowStarted(started, launched.requestedAt), true);
  assert.equal(invokeNowStarted("[2026-10-25T05:00:00.000Z] invoke now start\n", launched.requestedAt), false);
  const done = `${started}[2026-10-25T06:04:00.000Z] invoke now server and kiosk started\n`;
  assert.equal(invokeNowCompleted(done, launched.requestedAt), true);
  assert.equal(invokeNowCompleted(started, launched.requestedAt), false);
  const left = `${started}[2026-10-25T06:04:00.000Z] invoke now nightly left the wall running\n`;
  assert.equal(invokeNowCompleted(left, launched.requestedAt), true);
});

test("a broken photo processor tells the guest it is unavailable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-album-"));
  const album = new GuestAlbum({
    root: dir,
    sharpLoader() {
      throw new SyntaxError("Invalid or unexpected token");
    },
  });
  await assert.rejects(
    () => album.ingest(Buffer.from("not-a-photo"), { ip: "guest" }),
    (err) => err.status === 503 && err.message === "photo processor unavailable"
  );
});

test("turning updates off skips fetch on boot", async () => {
  const ctx = await setup();
  let called = false;
  const result = await runSelfUpdate({
    appRoot: ctx.appRoot,
    dataDir: ctx.dataDir,
    mode: "boot",
    updates: { enabled: false },
    run: async () => {
      called = true;
      return ok("");
    },
    smoke: async () => ({ ok: true }),
    runTests: async () => ({ ok: true }),
  });
  assert.equal(result.action, "skipped");
  assert.equal(called, false);
  await ctx.assertDataUntouched();
});

test("a plan reports that main moved without installing", async () => {
  const ctx = await setup();
  const script = scripted();
  const result = await update(ctx, script, { recordOnly: true });
  assert.equal(result.action, "update-available");
  assert.equal(script.npmCount(), 0);
  assert.equal(script.calls.some((call) => call[1] === "clone"), false);
  await ctx.assertDataUntouched();
});

test("a partial staging folder is discarded and a good previous install is restored", async () => {
  const ctx = await setup();
  const paths = stagePaths(ctx.appRoot);
  await fs.cp(ctx.appRoot, paths.previous, { recursive: true });
  await writeMarker(ctx.dataDir, { phase: "staging", commit: NEXT, at: "2026-10-25T00:00:00.000Z" });
  await fs.mkdir(paths.staging, { recursive: true });
  await fs.writeFile(path.join(paths.staging, "partial.txt"), "partial");
  const zero = path.join(ctx.appRoot, "node_modules", "sharp", "index.js");
  await fs.mkdir(path.dirname(zero), { recursive: true });
  await fs.writeFile(zero, Buffer.alloc(80, 0));
  const result = await repairInstall({
    appRoot: ctx.appRoot,
    dataDir: ctx.dataDir,
    npmBin: "npm.cmd",
    run: async () => ok(""),
  });
  assert.equal(result.recovered, true);
  assert.equal(result.ok, true);
  assert.equal(result.action, "rolled-back");
  await assert.rejects(() => fs.stat(paths.staging));
  await assert.rejects(() => fs.stat(zero));
  const status = JSON.parse(await fs.readFile(path.join(ctx.dataDir, "logs", "update-status.json"), "utf8"));
  assert.equal(status.integrityOk, true);
});

test("a staged update waits to swap until the server can restart alone", async () => {
  const ctx = await setup();
  await fs.writeFile(path.join(ctx.appRoot, "live-marker.txt"), "live");
  const script = scripted();
  const staged = await update(ctx, script, { stageOnly: true });
  assert.equal(staged.action, "staged");
  assert.equal(staged.commit, NEXT);
  assert.equal(await fs.readFile(path.join(ctx.appRoot, "live-marker.txt"), "utf8"), "live");
  const marker = JSON.parse(await fs.readFile(path.join(ctx.dataDir, "updates", "staging.json"), "utf8"));
  assert.equal(marker.phase, "ready");
  assert.equal(marker.commit, NEXT);
  const swapped = await update(ctx, script, { swapOnly: true });
  assert.equal(swapped.action, "updated");
  assert.equal(swapped.commit, NEXT);
  await assert.rejects(() => fs.stat(path.join(ctx.appRoot, "live-marker.txt")));
  await ctx.assertDataUntouched();
});

test("quickScanInstall ignores a zero-filled file under node_modules", async () => {
  const { quickScanInstall } = require("../src/install-guard");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-quick-"));
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  await fs.mkdir(path.join(root, "node_modules", "electron", "dist"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "electron", "path.txt"), `dist/${exe}\n`);
  await fs.writeFile(path.join(root, "node_modules", "electron", "dist", exe), "electron-binary");
  await fs.writeFile(path.join(root, "src", "server.js"), "ok\n");
  const buried = path.join(root, "node_modules", "sharp", "index.js");
  await fs.mkdir(path.dirname(buried), { recursive: true });
  await fs.writeFile(buried, Buffer.alloc(64, 0));
  const quick = await quickScanInstall(root);
  assert.equal(quick.ok, true);
  const full = await scanInstall(root);
  assert.equal(full.ok, false);
  await fs.writeFile(path.join(root, "src", "server.js"), Buffer.alloc(64, 0));
  const blocked = await quickScanInstall(root);
  assert.equal(blocked.ok, false);
});

test("scanInstall names a zero-filled runtime file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-zero-"));
  const file = path.join(root, "node_modules", "sharp", "index.js");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(64, 0));
  const scanned = await scanInstall(root);
  assert.equal(scanned.ok, false);
  assert.match(scanned.detail, /zero-filled/);
});
