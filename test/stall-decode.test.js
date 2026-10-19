const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");
const { createConfigStore } = require("../src/config");
const { noteStall } = require("../src/playback-flags");

test("only stall timeouts and give-ups count, and the third one enables software decode", () => {
  assert.deepEqual(noteStall(0, "waiting"), { count: 0, enable: false });
  assert.deepEqual(noteStall(0, "progress"), { count: 0, enable: false });
  assert.deepEqual(noteStall(0, "stall-timeout"), { count: 1, enable: false });
  assert.deepEqual(noteStall(1, "give-up"), { count: 2, enable: false });
  assert.deepEqual(noteStall(2, "stall-timeout"), { count: 3, enable: true });
  assert.deepEqual(noteStall(2, "give-up"), { count: 3, enable: true });
});

test("three stalls persist software decode and the log records screen, gpu, and frames", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-stall-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const configStore = createConfigStore(path.join(dir, "config.json"));
  const root = path.join(__dirname, "..");
  const { app, attachWebSocket } = createApp({
    store,
    configStore,
    dataDir: dir,
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dir, "opdb"),
    uploadsDir: path.join(dir, "uploads"),
    devicesPath: path.join(dir, "devices.json"),
    guestPhotosDir: path.join(dir, "guest-photos"),
    catalogPath: path.join(root, "media", "catalog.json"),
    publicProbe: async () => ({ url: "", source: "" }),
  });
  const server = http.createServer(app);
  attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const send = (event) => socket.send(JSON.stringify({
      type: "media-failure",
      event,
      slot: "1",
      id: "christmas-comes-1936",
      title: "Christmas Comes But Once a Year",
      readyState: 1,
      networkState: 2,
      screen: "1920x1080@0,0",
      gpu: "ANGLE (NVIDIA, RTX 5070)",
      dropped: 12,
      total: 40,
    }));
    send("stall-timeout");
    send("give-up");
    await new Promise((resolve) => setTimeout(resolve, 150));
    let health = await (await fetch(`${origin}/api/health`)).json();
    assert.equal(health.softwareVideoDecode, false);
    send("stall-timeout");
    let enabled = false;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      health = await (await fetch(`${origin}/api/health`)).json();
      if (health.softwareVideoDecode === true) {
        enabled = true;
        break;
      }
    }
    assert.equal(enabled, true);
    const log = await fs.readFile(path.join(dir, "logs", "video.log"), "utf8");
    assert.match(log, /event=stall-timeout/);
    assert.match(log, /screen=1920x1080@0,0/);
    assert.match(log, /gpu="ANGLE \(NVIDIA, RTX 5070\)"/);
    assert.match(log, /dropped=12/);
    assert.match(log, /total=40/);
    assert.match(log, /event=software-decode reason=repeated-stalls/);
    const saved = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
    assert.equal(saved.media.softwareDecode, true);
  } finally {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
