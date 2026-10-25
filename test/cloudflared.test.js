const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const {
  cloudflaredAsset,
  ensureCloudflared,
  createCloudflareTunnel,
  plainTunnelError,
  sha256Buffer,
  shouldRestartTunnel,
} = require("../src/cloudflared");

test("cloudflared download keeps a matching file and rejects a bad checksum", async () => {
  const asset = cloudflaredAsset("win32", "x64");
  assert.equal(asset.file, "cloudflared.exe");
  assert.equal(asset.sha256.length, 64);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-cloud-"));
  const body = Buffer.from("cloudflared-bytes");
  const hash = sha256Buffer(body);
  const saved = cloudflaredAsset("linux", "x64");
  const original = saved.sha256;
  saved.sha256 = hash;
  try {
    let calls = 0;
    const dest = await ensureCloudflared({
      binDir: dir,
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, arrayBuffer: async () => body };
      },
    });
    assert.equal(calls, 1);
    assert.equal(path.basename(dest), "cloudflared");
    assert.equal(fs.readFileSync(dest).equals(body), true);
    const again = await ensureCloudflared({
      binDir: dir,
      platform: "linux",
      arch: "x64",
      fetchImpl: async () => { throw new Error("should reuse the checked file"); },
    });
    assert.equal(again, dest);
    saved.sha256 = crypto.createHash("sha256").update("nope").digest("hex");
    await assert.rejects(
      () => ensureCloudflared({
        binDir: dir,
        platform: "linux",
        arch: "x64",
        fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }),
      }),
      (err) => err.code === "checksum" && /checksum/.test(plainTunnelError(err)),
    );
    assert.equal(fs.existsSync(dest), false);
  } finally {
    saved.sha256 = original;
  }
});

test("the tunnel parses the guest URL and restarts after the process exits", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-tunnel-"));
  const asset = cloudflaredAsset("linux", "x64");
  const original = asset.sha256;
  const body = Buffer.from("bin");
  asset.sha256 = sha256Buffer(body);
  const children = [];
  try {
    const tunnel = createCloudflareTunnel({
      binDir: dir,
      logFile: path.join(dir, "logs", "tunnel.log"),
      port: () => 3010,
      platform: "linux",
      arch: "x64",
      backoffStart: 20,
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }),
      spawnImpl(bin, args) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => child.emit("exit", 0);
        child.bin = bin;
        child.args = args;
        children.push(child);
        return child;
      },
    });
    tunnel.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(children.length, 1);
    assert.equal(path.isAbsolute(children[0].bin), true);
    assert.notEqual(path.basename(children[0].bin), children[0].bin);
    assert.equal(path.basename(children[0].bin), "cloudflared");
    assert.deepEqual(children[0].args.slice(0, 3), ["tunnel", "--no-autoupdate", "--url"]);
    assert.equal(children[0].args[3], "http://127.0.0.1:3010");
    children[0].stderr.emit("data", "request at https://pinball-guest.trycloudflare.com ready\n");
    assert.equal(tunnel.status().url, "https://pinball-guest.trycloudflare.com");
    assert.match(tunnel.status().detail, /Cloudflare is up/);
    children[0].emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(children.length >= 2, true);
    tunnel.stop();
    const log = await fsp.readFile(path.join(dir, "logs", "tunnel.log"), "utf8");
    assert.match(log, /https:\/\/pinball-guest\.trycloudflare\.com/);
    assert.match(log, /127\.0\.0\.1:3010/);
    assert.match(log, new RegExp(children[0].bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    asset.sha256 = original;
  }
});

test("a spawn failure names the downloaded file and is written to the tunnel log", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-tunnel-"));
  const asset = cloudflaredAsset("win32", "x64");
  const original = asset.sha256;
  const body = Buffer.from("bin");
  asset.sha256 = sha256Buffer(body);
  let tunnel;
  try {
    tunnel = createCloudflareTunnel({
      binDir: dir,
      logFile: path.join(dir, "logs", "tunnel.log"),
      port: 3010,
      platform: "win32",
      arch: "x64",
      backoffStart: 60000,
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }),
      spawnImpl(bin) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => {
          child.emit("error", Object.assign(new Error(`spawn ${bin} ENOENT`), { code: "ENOENT", path: bin }));
        });
        return child;
      },
    });
    tunnel.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(tunnel.status().detail, /could not be launched/);
    assert.match(tunnel.status().detail, /cloudflared\.exe/);
    const log = await fsp.readFile(path.join(dir, "logs", "tunnel.log"), "utf8");
    assert.match(log, /spawn error/);
    assert.match(log, /cloudflared\.exe/);
    assert.match(log, /ENOENT/);
    assert.equal(log.includes(" start cloudflared "), false);
  } finally {
    tunnel?.stop();
    asset.sha256 = original;
  }
});

test("shouldRestartTunnel uses three misses after a pass, or five minutes", () => {
  assert.equal(shouldRestartTunnel({ failing: true, passedOnce: true, failures: 2, failingForMs: 1000 }), false);
  assert.equal(shouldRestartTunnel({ failing: true, passedOnce: true, failures: 3, failingForMs: 1000 }), true);
  assert.equal(shouldRestartTunnel({ failing: true, passedOnce: false, failures: 9, failingForMs: 1000 }), false);
  assert.equal(shouldRestartTunnel({ failing: true, passedOnce: false, failures: 1, failingForMs: 5 * 60 * 1000 }), true);
  assert.equal(shouldRestartTunnel({ failing: false, passedOnce: true, failures: 3, failingForMs: 9 * 60 * 1000 }), false);
});

test("repeated tunnel registration errors kill cloudflared for a fresh url", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-tunnel-"));
  const asset = cloudflaredAsset("linux", "x64");
  const original = asset.sha256;
  const body = Buffer.from("bin");
  asset.sha256 = sha256Buffer(body);
  const children = [];
  let tunnel;
  try {
    tunnel = createCloudflareTunnel({
      binDir: dir,
      logFile: path.join(dir, "logs", "tunnel.log"),
      port: 3010,
      platform: "linux",
      arch: "x64",
      backoffStart: 20,
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => body }),
      spawnImpl(bin, args) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => child.emit("exit", 0);
        child.args = args;
        children.push(child);
        return child;
      },
    });
    tunnel.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    children[0].stderr.emit("data", "https://old-name.trycloudflare.com\n");
    assert.equal(tunnel.status().url, "https://old-name.trycloudflare.com");
    const line = 'ERR Register tunnel error from server side error="Unauthorized: Tunnel not found"\n';
    children[0].stderr.emit("data", line);
    children[0].stderr.emit("data", line);
    assert.equal(children.length, 1);
    assert.equal(tunnel.status().url, "https://old-name.trycloudflare.com");
    children[0].stderr.emit("data", line);
    assert.equal(tunnel.status().url, "");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(children.length >= 2, true);
    const log = await fsp.readFile(path.join(dir, "logs", "tunnel.log"), "utf8");
    assert.match(log, /restart tunnel registration failed/);
  } finally {
    tunnel?.stop();
    asset.sha256 = original;
  }
});
