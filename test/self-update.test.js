const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { normalizeUpdates } = require("../src/config");
const { appendUpdateLog, runSelfUpdate } = require("../src/self-update");

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
  await fs.writeFile(path.join(appRoot, "node_modules", "electron", "dist", exe), "");
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

function scripted({ ahead = "1", fetchMode = "ok", npmFailOn = 0 } = {}) {
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
    if (args[0] === "ci") {
      npmCalls += 1;
      if (npmFailOn && npmCalls === npmFailOn) return fail("npm ci exploded");
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

test("npm ci failure resets to the previous commit and leaves venue data alone", async () => {
  const ctx = await setup();
  const script = scripted({ npmFailOn: 1 });
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
  assert.ok(script.calls.some((call) => call[0] === "git" && call[1] === "reset" && call[2] === "--hard" && call[3] === HEAD));
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
  assert.equal(script.npmCount(), 2);
  assert.ok(script.calls.filter((call) => call[0] === "git" && call[1] === "reset" && call[3] === HEAD).length >= 1);
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
