const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { startServer } = require("../src/server");
const { openGuestPort } = require("../src/guest-listener");
const { startQuickTunnel } = require("../src/public-access");

test("public access binds guest port 3010 at boot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-guest-port-"));
  const previous = {
    PINBALL_DATA_DIR: process.env.PINBALL_DATA_DIR,
    PINBALL_CLIP_CACHE: process.env.PINBALL_CLIP_CACHE,
    PORT: process.env.PORT,
    HTTPS_PORT: process.env.HTTPS_PORT,
  };
  process.env.PINBALL_DATA_DIR = dir;
  process.env.PINBALL_CLIP_CACHE = "0";
  process.env.PORT = "3000";
  process.env.HTTPS_PORT = "0";
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({
    port: 3000,
    httpsPort: 0,
    pin: "2224",
    publicAccess: { enabled: true, cloudflare: false },
  }));
  let started;
  try {
    started = await startServer();
    assert.equal(started.port, 3000);
    assert.equal(started.guestPort, 3010);
    assert.equal(started.guestListening, true, started.guestError);
    const admin = await fetch("http://127.0.0.1:3010/admin");
    assert.equal(admin.status, 404);
    const state = await fetch("http://127.0.0.1:3010/api/state");
    assert.equal(state.status, 404);
    const display = await fetch("http://127.0.0.1:3010/display/1");
    assert.equal(display.status, 404);
    const home = await fetch("http://127.0.0.1:3010/");
    assert.equal(home.status, 403);
    const log = await fs.readFile(path.join(dir, "logs", "tunnel.log"), "utf8");
    assert.match(log, /guest listening 0\.0\.0\.0:3010/);
    const settings = await fetch("http://127.0.0.1:3000/api/state", { headers: { "x-pin": "2224" } });
    const body = await settings.json();
    assert.equal(body.publicAccess.enabled, true);
    assert.equal(/not listening/i.test(body.publicAccess.detail || ""), false);
  } finally {
    if (started) await started.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a guest listen failure is written to the tunnel log in plain words", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-guest-log-"));
  const logFile = path.join(dir, "tunnel.log");
  const result = await openGuestPort(() => {}, 3010, {
    logFile,
    createServerImpl() {
      const server = new EventEmitter();
      server.listening = false;
      server.close = (done) => { if (done) done(); };
      return server;
    },
    listenImpl() {
      return Promise.reject(Object.assign(new Error("listen EACCES: permission denied 0.0.0.0:3010"), { code: "EACCES" }));
    },
  });
  assert.equal(result.listening, false);
  assert.match(result.error, /Guest port 3010 is not listening/);
  assert.match(result.error, /EACCES/);
  const log = await fs.readFile(logFile, "utf8");
  assert.match(log, /guest listen error 0\.0\.0\.0:3010 EACCES/);
  assert.match(log, /guest listen error 127\.0\.0\.1:3010 EACCES/);
});

test("the quick tunnel does not spawn cloudflared from PATH", () => {
  let spawned = null;
  const missing = startQuickTunnel({
    port: 3010,
    spawnImpl(command) {
      spawned = command;
      return null;
    },
  });
  assert.equal(missing, null);
  assert.equal(spawned, null);
  const bin = path.join(os.tmpdir(), "cloudflared.exe");
  const child = startQuickTunnel({
    bin,
    port: 3010,
    spawnImpl(command, args) {
      spawned = command;
      assert.equal(args[3], "http://127.0.0.1:3010");
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      return proc;
    },
  });
  assert.equal(spawned, bin);
  assert.equal(path.isAbsolute(spawned), true);
  assert.notEqual(spawned, "cloudflared");
  child.kill();
});
