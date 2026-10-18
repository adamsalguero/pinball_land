const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { displayOrigins, originHost, discoverDisplayOrigins } = require("../src/display-origins");
const { bindDisplayServers, KEEP_ALIVE_MS, HEADERS_TIMEOUT_MS } = require("../src/server");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");

test("each display origin is a different host", () => {
  const origins = displayOrigins({ port: 3000, ipv6: true });
  assert.equal(origins[1], "http://localhost:3000");
  assert.equal(origins[2], "http://127.0.0.1:3000");
  assert.equal(origins[3], "http://[::1]:3000");
  const hosts = new Set(Object.values(origins).map(originHost));
  assert.equal(hosts.size, 3);
  const fallback = displayOrigins({ port: 3000, ipv6: false, extraPort: 3001 });
  assert.equal(fallback[3], "http://127.0.0.1:3001");
  assert.equal(new Set(Object.values(fallback).map(originHost)).size, 3);
});

test("the wall server answers on three origins and times out idle sockets", async () => {
  const bound = await bindDisplayServers((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }, { port: 0 });
  try {
    assert.equal(bound.servers[0].keepAliveTimeout, KEEP_ALIVE_MS);
    assert.equal(bound.servers[0].headersTimeout, HEADERS_TIMEOUT_MS);
    assert.ok(bound.servers[0].headersTimeout > bound.servers[0].keepAliveTimeout);
    const hosts = new Set();
    for (const base of Object.values(bound.displayOrigins)) {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      hosts.add(originHost(base));
    }
    assert.equal(hosts.size, 3);
    const discovered = await discoverDisplayOrigins(bound.port);
    assert.equal(discovered[3], bound.displayOrigins[3]);
  } finally {
    await Promise.all(bound.servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

test("a display reports a clip failure over the websocket and it lands in video.log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-ws-fail-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  const { app, attachWebSocket } = createApp({
    store,
    pin: "2224",
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dir, "opdb"),
    dataDir: dir,
    mediaDir: path.join(dir, "media"),
  });
  const server = http.createServer(app);
  attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.openMedia, 0);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      type: "media-failure",
      event: "give-up",
      slot: "2",
      id: "skeleton-dance",
      title: "Skeleton Dance",
      readyState: 1,
      networkState: 1,
      currentTime: 12.5,
      src: "/media/cache/skeleton-dance",
      failedIds: ["skeleton-dance"],
    }));
    let log = "";
    for (let i = 0; i < 20; i += 1) {
      try {
        log = await fs.readFile(path.join(dir, "logs", "video.log"), "utf8");
        if (log.includes("event=give-up")) break;
      } catch { /* not written yet */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(log, /event=give-up/);
    assert.match(log, /slot=2/);
    assert.match(log, /readyState=1/);
    socket.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
