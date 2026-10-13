const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");

async function startServer(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-land-api-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  const { app, attachWebSocket } = createApp({
    store,
    pin: "1234",
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dir, "opdb"),
    ...overrides,
  });
  const server = http.createServer(app);
  attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, store, port, origin: `http://127.0.0.1:${port}`, dir };
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

test("serves display, control, SVG logos, and oasis photo", async () => {
  const { server, origin } = await startServer();
  try {
    const control = await fetch(`${origin}/`);
    const display = await fetch(`${origin}/display/2`);
    const logo = await fetch(`${origin}/logos/pinnacle`);
    const photo = await fetch(`${origin}/photos/oasis`);
    assert.equal(control.status, 200);
    assert.equal(display.status, 200);
    assert.equal(logo.status, 200);
    assert.equal(photo.status, 200);
    const controlText = await control.text();
    const displayText = await display.text();
    const logoText = await logo.text();
    assert.match(controlText, /Kiosk control/);
    assert.match(controlText, /Outdoor Oasis/);
    assert.match(controlText, /Displays/);
    assert.match(controlText, /isn't practical/);
    assert.match(controlText, /Chromecast/);
    assert.doesNotMatch(controlText, /\bpool\b/i);
    const present = await fetch(`${origin}/present`);
    assert.equal(present.status, 200);
    assert.match(await present.text(), /iPhone and iPad Safari cannot share/);
    assert.match(displayText, /Pinball Land display/);
    assert.match(logo.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.doesNotMatch(logoText, /PLACEHOLDER LOGO/);
    assert.match(logoText, /Pinnacle Group Financial Services/);
    assert.match(photo.headers.get("content-type") || "", /image\/png/);
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
        if (message.state?.blackout === true) {
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
    assert.equal(off.data.state.blackout, true);
    assert.equal(off.data.state.rotation.enabled, true);
    await wsState;
  } finally {
    server.close();
  }
});

test("rotation payload, amenity copy, theme, and machine enable", async () => {
  const { server, origin } = await startServer();
  try {
    const headers = { "x-pin": "1234" };
    const state = await json(origin, "/api/state");
    assert.equal(state.data.state.rotation.enabled, true);
    assert.ok(state.data.playlist.length >= 6);
    assert.deepEqual(
      state.data.amenities.map((item) => item.id),
      ["arcade", "oasis", "events"]
    );
    assert.ok(state.data.photos.oasis);
    assert.equal(state.data.photos.pool, undefined);

    const themed = await json(origin, "/api/theme", {
      method: "PUT",
      headers,
      body: { theme: "halloween" },
    });
    assert.equal(themed.data.state.theme, "halloween");

    const added = await json(origin, "/api/machines", {
      method: "POST",
      headers,
      body: { name: "Attack From Mars" },
    });
    const machine = added.data.state.leaderboards.at(-1);
    assert.equal(machine.kind, "machine");
    assert.equal(machine.inRotation, true);
    assert.ok(added.data.playlist.some((card) => card.type === "leaderboard" && card.id === machine.id));

    const hidden = await json(origin, `/api/leaderboards/${machine.id}`, {
      method: "PUT",
      headers,
      body: { inRotation: false },
    });
    assert.equal(hidden.data.state.leaderboards.find((board) => board.id === machine.id).inRotation, false);
    assert.equal(
      hidden.data.playlist.some((card) => card.type === "leaderboard" && card.id === machine.id),
      false
    );
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

test("OPDB search uses injected fetch and caches art when a token is present", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/search?")) {
      return {
        ok: true,
        json: async () => [
          {
            opdb_id: "GTEST-M1",
            name: "Medieval Madness",
            manufacturer: { manufacturer_name: "Williams" },
            manufacture_date: "1997-01-01",
            images: [{ type: "backglass", urls: { large: "https://example.test/mm.png" } }],
          },
        ],
      };
    }
    if (href.includes("/machines/GTEST-M1")) {
      return {
        ok: true,
        json: async () => ({
          opdb_id: "GTEST-M1",
          name: "Medieval Madness",
          manufacturer: { manufacturer_name: "Williams" },
          manufacture_date: "1997-01-01",
          images: [{ type: "backglass", urls: { large: "https://example.test/mm.png" } }],
        }),
      };
    }
    if (href.includes("example.test/mm.png")) {
      return {
        ok: true,
        arrayBuffer: async () => png,
      };
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const { server, origin, dir } = await startServer({
    opdbApiKey: "test-token",
    fetchImpl,
  });
  try {
    const headers = { "x-pin": "1234" };
    const search = await json(origin, "/api/opdb/search?q=Medieval", { headers });
    assert.equal(search.data.configured, true);
    assert.equal(search.data.results[0].name, "Medieval Madness");

    const added = await json(origin, "/api/machines", {
      method: "POST",
      headers,
      body: { name: "Medieval Madness", opdbId: "GTEST-M1" },
    });
    const machine = added.data.state.leaderboards.at(-1);
    assert.equal(machine.artUrl, `/media/machines/${machine.id}/art`);
    const art = await fetch(`${origin}${machine.artUrl}`);
    assert.equal(art.status, 200);
    const cached = await fs.readdir(path.join(dir, "opdb", "GTEST-M1"));
    assert.ok(cached.includes("machine.json"));
    assert.ok(cached.some((name) => name.startsWith("art")));
  } finally {
    server.close();
  }
});

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

test("display settings, restart, and monitor order are PIN protected and live", async () => {
  const { server, origin } = await startServer();
  try {
    const headers = { "x-pin": "1234" };
    const denied = await json(origin, "/api/displays", { method: "PUT", body: { count: 1 } });
    assert.equal(denied.res.status, 401);

    const updated = await json(origin, "/api/displays", {
      method: "PUT",
      headers,
      body: {
        count: 2,
        mirror: true,
        screens: { 1: { content: "pinnacle" }, 2: { content: "off" } },
      },
    });
    assert.equal(updated.data.displays.count, 2);
    assert.equal(updated.data.displays.mirror, true);
    assert.equal(updated.data.displays.screens["2"].content, "off");
    assert.equal(updated.data.layout["2"].content, "pinnacle");
    assert.equal(updated.data.layout["2"].staggerIndex, 0);
    assert.equal(updated.data.layout["3"].enabled, false);

    const monitors = await json(origin, "/api/kiosk/monitors", {
      method: "POST",
      body: {
        displays: [
          { id: "right", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
          { id: "left", bounds: { x: 0, y: 0, width: 1280, height: 720 } },
        ],
      },
    });
    assert.equal(monitors.res.status, 200);
    const state = await json(origin, "/api/state");
    assert.deepEqual(state.data.kiosk.monitors.map((item) => item.id), ["left", "right"]);
    assert.deepEqual(state.data.kiosk.planned.map((item) => item.slot), [1, 2]);

    const ordered = await json(origin, "/api/displays", {
      method: "PUT",
      headers,
      body: { order: ["right", "left"] },
    });
    assert.equal(ordered.data.kiosk.planned[0].id, "right");

    const restarted = await json(origin, "/api/kiosk/restart", { method: "POST", headers });
    assert.equal(restarted.data.kiosk.restartToken, 1);
    const idle = await json(origin, "/api/presentation", {
      method: "PUT",
      headers,
      body: { idleMinutes: 12 },
    });
    assert.equal(idle.data.presentation.idleMinutes, 12);
  } finally {
    server.close();
  }
});

test("one screen can present while the others stay in rotation", async () => {
  const { server, origin, port } = await startServer();
  try {
    const headers = { "x-pin": "1234" };
    const denied = await json(origin, "/api/present/1/start", {
      method: "POST",
      body: { source: "webrtc" },
    });
    assert.equal(denied.res.status, 401);

    const badUrl = await json(origin, "/api/present/1/start", {
      method: "POST",
      headers,
      body: { source: "url", url: "javascript:alert(1)" },
    });
    assert.equal(badUrl.res.status, 400);

    await json(origin, "/api/displays", {
      method: "PUT",
      headers,
      body: { screens: { 3: { enabled: false } } },
    });
    const disabled = await json(origin, "/api/present/3/start", {
      method: "POST",
      headers,
      body: { source: "url", url: "https://example.com" },
    });
    assert.equal(disabled.res.status, 400);

    const started = await json(origin, "/api/present/2/start", {
      method: "POST",
      headers,
      body: { source: "webrtc" },
    });
    const session = started.data.presentations["2"];
    assert.equal(started.data.presentations["1"], undefined);
    assert.equal(started.data.layout["1"].content, "rotation");
    assert.match(session.code, /^\d{4}$/);
    assert.equal(session.token, undefined);
    assert.equal(session.helper, null);

    const joined = await json(origin, "/api/present/join", {
      method: "POST",
      body: { code: session.code },
    });
    assert.equal(joined.res.status, 200);
    const wrong = await json(origin, "/api/present/join", {
      method: "POST",
      body: { code: "9999" },
    });
    assert.equal(wrong.res.status, 401);

    const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const sharer = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await Promise.all([opened(viewer), opened(sharer)]);
    const gotOffer = new Promise((resolve, reject) => {
      viewer.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "present-signal" && message.payload?.kind === "offer") resolve(message);
      });
      setTimeout(() => reject(new Error("timed out waiting for the share offer")), 3000);
    });
    const viewerReady = new Promise((resolve, reject) => {
      sharer.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "present-viewer-ready") resolve(message);
      });
      setTimeout(() => reject(new Error("timed out waiting for the display")), 3000);
    });
    viewer.send(JSON.stringify({ type: "present-hello", presentationId: session.id, role: "viewer" }));
    sharer.send(JSON.stringify({
      type: "present-hello",
      presentationId: session.id,
      role: "sharer",
      token: joined.data.token,
    }));
    await viewerReady;
    sharer.send(JSON.stringify({
      type: "present-signal",
      presentationId: session.id,
      token: joined.data.token,
      payload: { kind: "offer", sdp: { type: "offer", sdp: "v=0" } },
    }));
    const offer = await gotOffer;
    assert.equal(offer.from, "sharer");
    assert.equal(offer.payload.sdp.sdp, "v=0");
    viewer.close();
    sharer.close();

    const ended = await json(origin, "/api/present/2/end", { method: "POST", headers });
    assert.equal(ended.data.presentations["2"], undefined);
    assert.equal(ended.data.layout["1"].content, "rotation");
  } finally {
    server.close();
  }
});

test("uploads a PNG onto one screen and removes it when the presentation ends", async () => {
  const { server, origin } = await startServer();
  try {
    const headers = { "x-pin": "1234" };
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const uploaded = await fetch(`${origin}/api/present/1/file`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "image/png",
        "x-filename": "guest slide.png",
      },
      body: png,
    });
    const data = await uploaded.json();
    assert.equal(uploaded.status, 200);
    const session = data.presentations["1"];
    assert.equal(session.source, "file");
    assert.equal(session.fileKind, "image");
    assert.equal(data.presentations["2"], undefined);
    const file = await fetch(`${origin}${session.fileUrl}`);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") || "", /image\/png/);

    const ended = await json(origin, "/api/present/1/end", { method: "POST", headers });
    assert.equal(ended.data.presentations["1"], undefined);
    const gone = await fetch(`${origin}${session.fileUrl}`);
    assert.equal(gone.status, 404);
  } finally {
    server.close();
  }
});
