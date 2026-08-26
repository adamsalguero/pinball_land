const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");

async function startServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-land-api-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  const { app, attachWebSocket } = createApp({
    store,
    pin: "1234",
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
  });
  const server = http.createServer(app);
  attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, store, port, origin: `http://127.0.0.1:${port}` };
}

async function json(origin, url, options = {}) {
  const res = await fetch(`${origin}${url}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

test("serves display and control pages", async () => {
  const { server, origin } = await startServer();
  try {
    const control = await fetch(`${origin}/`);
    const display = await fetch(`${origin}/display/2`);
    assert.equal(control.status, 200);
    assert.equal(display.status, 200);
    assert.match(await control.text(), /Kiosk control/);
    assert.match(await display.text(), /Pinball Land display/);
  } finally {
    server.close();
  }
});

test("PIN gates mutations; login cookie allows off and live WS update", async () => {
  const { server, origin, port } = await startServer();
  try {
    const denied = await json(origin, "/api/off", { method: "POST" });
    assert.equal(denied.res.status, 401);

    const login = await json(origin, "/api/login", { method: "POST", body: { pin: "1234" } });
    assert.equal(login.res.status, 200);
    const cookie = login.res.headers.get("set-cookie");
    assert.ok(cookie);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    const wsState = new Promise((resolve, reject) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.state?.slots["1"].content === "off") {
          socket.close();
          resolve(true);
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timed out waiting for off broadcast")), 3000);
    });

    const off = await json(origin, "/api/off", {
      method: "POST",
      headers: { cookie: cookie.split(";")[0] },
    });
    assert.equal(off.res.status, 200);
    assert.equal(off.data.state.slots["1"].content, "off");
    assert.equal(off.data.state.slots["2"].content, "off");
    assert.equal(off.data.state.slots["3"].content, "off");
    await wsState;
  } finally {
    server.close();
  }
});

test("can switch a slot and add a score with the PIN header", async () => {
  const { server, origin } = await startServer();
  try {
    const state = await json(origin, "/api/state");
    const boardId = state.data.state.leaderboards[0].id;
    const headers = { "x-pin": "1234" };
    const slot = await json(origin, "/api/slots/1", {
      method: "PUT",
      headers,
      body: { content: "leaderboard", leaderboardId: boardId },
    });
    assert.equal(slot.data.state.slots["1"].content, "leaderboard");

    const added = await json(origin, `/api/leaderboards/${boardId}/rows`, {
      method: "POST",
      headers,
      body: { name: "Taylor", score: "333" },
    });
    assert.ok(added.data.state.leaderboards[0].rows.some((row) => row.name === "Taylor"));
  } finally {
    server.close();
  }
});
