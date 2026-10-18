const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");
const { PlugService } = require("../src/plugs");

async function startServer(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-land-api-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  const { app, attachWebSocket } = createApp({
    store,
    pin: "2224",
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
    const control = await fetch(`${origin}/admin`);
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
    assert.match(controlText, /Auto \(rotate all\)/);
    assert.match(controlText, /Videos/);
    assert.doesNotMatch(controlText, /Test videos/);
    assert.doesNotMatch(controlText, /All-ages/);
    assert.doesNotMatch(controlText, /Chromecast/);
    assert.doesNotMatch(controlText, /\bpool\b/i);
    const present = await fetch(`${origin}/present`);
    assert.equal(present.status, 200);
    assert.match(await present.text(), /iPhone and iPad Safari cannot share/);
    assert.match(displayText, /Pinball Land display/);
    assert.match(logo.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.doesNotMatch(logoText, /PLACEHOLDER LOGO/);
    assert.match(logoText, /Pinnacle Group Financial Services/);
    assert.doesNotMatch(logoText, /<rect\b/i);
    assert.match(logoText, /#F4EFE4/);
    assert.match(logoText, /#81338B/);
    assert.match(logoText, /id="subtitle"[^>]*>\s*<path\b[^>]*fill="#C79BD0"/);
    assert.doesNotMatch(logoText, /#504E50/);
    assert.match(photo.headers.get("content-type") || "", /image\/(png|jpeg)/);
  } finally {
    server.close();
  }
});

test("PIN gates mutations; login cookie allows a live update and black does not blank the wall", async () => {
  const { server, origin, port } = await startServer();
  let socket;
  try {
    const denied = await json(origin, "/api/theme", { method: "PUT", body: { theme: "halloween" } });
    assert.equal(denied.res.status, 401);

    const login = await json(origin, "/api/login", { method: "POST", body: { pin: "2224" } });
    assert.equal(login.res.status, 200);
    const lines = login.res.headers.getSetCookie();
    const device = lines.find((line) => line.startsWith("pl_device="));
    const csrf = lines.find((line) => line.startsWith("pl_csrf="));
    assert.ok(device);
    assert.ok(csrf);
    const cookie = `${device.split(";")[0]}; ${csrf.split(";")[0]}`;
    const csrfHeaders = { cookie, "x-csrf": decodeURIComponent(csrf.split(";")[0].split("=")[1]) };

    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    const wsState = new Promise((resolve, reject) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.state?.theme === "halloween") {
          socket.close();
          resolve(true);
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timed out waiting for theme broadcast")), 3000);
    });

    const themed = await json(origin, "/api/theme", {
      method: "PUT",
      headers: csrfHeaders,
      body: { theme: "halloween" },
    });
    assert.equal(themed.res.status, 200);
    assert.equal(themed.data.state.theme, "halloween");
    const off = await json(origin, "/api/off", {
      method: "POST",
      headers: csrfHeaders,
    });
    assert.equal(off.res.status, 200);
    assert.equal(off.data.state.blackout, false);
    assert.equal(off.data.state.rotation.enabled, true);
    await wsState;
  } finally {
    socket?.close();
    server.close();
  }
});

test("rotation payload, amenity copy, theme, and machine enable", async () => {
  const { server, origin } = await startServer();
  try {
    const headers = { "x-pin": "2224" };
    const state = await json(origin, "/api/state");
    assert.equal(state.data.state.rotation.enabled, true);
    assert.ok(state.data.playlist.length >= 5);
    assert.ok(state.data.rotationPlan["1"]);
    assert.notEqual(state.data.rotationPlan["1"] && state.data.rotationPlan["1"].type + (state.data.rotationPlan["1"].key || state.data.rotationPlan["1"].id), state.data.rotationPlan["2"] && state.data.rotationPlan["2"].type + (state.data.rotationPlan["2"].key || state.data.rotationPlan["2"].id));
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
      body: { name: "Attack From Mars", opdbId: "GTEST-AFM" },
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
    const headers = { "x-pin": "2224" };
    const created = await json(origin, "/api/machines", {
      method: "POST",
      headers,
      body: { name: "Attack From Mars", opdbId: "GTEST-AFM" },
    });
    const boardId = created.data.state.leaderboards[0].id;
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
    const headers = { "x-pin": "2224" };
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
    const headers = { "x-pin": "2224" };
    const denied = await json(origin, "/api/displays", { method: "PUT", body: { count: 1 } });
    assert.equal(denied.res.status, 401);

    const updated = await json(origin, "/api/displays", {
      method: "PUT",
      headers,
      body: {
        count: 2,
        mirror: true,
        screens: { 1: { content: "logos" }, 2: { content: "black" } },
      },
    });
    assert.equal(updated.data.displays.count, 2);
    assert.equal(updated.data.displays.mirror, true);
    assert.equal(updated.data.displays.screens["2"].content, "rotation");
    assert.equal(updated.data.layout["2"].content, "logos");
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
    const headers = { "x-pin": "2224" };
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
    const headers = { "x-pin": "2224" };
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

test("airplay target, mocked plugs, and a christmas video", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-land-follow-"));
  const tv = {
    host: "192.168.1.50",
    alias: "Left TV",
    model: "HS103",
    deviceId: "plug-left",
    on: false,
    async getSysInfo() {
      return { alias: this.alias, model: this.model, deviceId: this.deviceId };
    },
    async getPowerState() {
      return this.on;
    },
    async setPowerState(value) {
      this.on = Boolean(value);
    },
  };
  const memory = {};
  const plugs = new PlugService({
    client: {
      async discover() {
        return [tv];
      },
      async getDevice(host) {
        if (host !== tv.host) throw new Error("missing plug");
        return tv;
      },
    },
    getConfig: () => memory,
    updateConfig: async (patch) => {
      memory.plugs = patch.plugs;
    },
  });
  const airplay = {
    active: false,
    ready() {
      return { ok: true };
    },
    ensureRunning() {
      return { ok: true, pid: 42 };
    },
    pid() {
      return 42;
    },
    isActive() {
      return this.active;
    },
    noteProbe(placed) {
      const was = this.active;
      this.active = Boolean(placed);
      if (this.active && !was) return "start";
      if (!this.active && was) return "end";
      return null;
    },
    stop() {},
  };
  const { server, origin } = await startServer({
    plugs,
    airplay,
    mediaDir: path.join(dir, "media"),
    mediaCatalog: path.join(dir, "library.json"),
  });
  try {
    const headers = { "x-pin": "2224" };
    const denied = await json(origin, "/api/plugs/discover", { method: "POST" });
    assert.equal(denied.res.status, 401);

    const target = await json(origin, "/api/airplay/target", {
      method: "PUT",
      headers,
      body: { target: "2" },
    });
    assert.equal(target.data.airplay.target, "2");
    assert.equal(target.data.airplay.active, false);
    assert.equal(target.data.presentations["2"], undefined);

    const live = await json(origin, "/api/airplay/probe", { method: "POST", body: { placed: true } });
    assert.equal(live.data.active, true);
    const state = await json(origin, "/api/state");
    assert.equal(state.data.presentations["2"].source, "airplay");
    assert.equal(state.data.presentations["1"], undefined);
    assert.equal(state.data.presentations["2"].helper.capture, false);

    const all = await json(origin, "/api/airplay/target", {
      method: "PUT",
      headers,
      body: { target: "all" },
    });
    assert.equal(all.data.presentations["1"].helper.capture, false);
    assert.equal(all.data.presentations["2"].helper.capture, true);
    assert.equal(all.data.presentations["3"].helper.capture, true);

    const ended = await json(origin, "/api/airplay/probe", { method: "POST", body: { placed: false } });
    assert.equal(ended.data.active, false);
    const back = await json(origin, "/api/state");
    assert.equal(back.data.presentations["1"], undefined);
    assert.equal(back.data.presentations["2"], undefined);

    const found = await json(origin, "/api/plugs/discover", { method: "POST", headers });
    assert.equal(found.data.plugs.devices[0].name, "Left TV");
    const assigned = await json(origin, "/api/plugs/assignments", {
      method: "PUT",
      headers,
      body: { 1: "plug-left" },
    });
    assert.equal(assigned.data.plugs.assignments["1"], "plug-left");
    const powered = await json(origin, "/api/plugs/1/power", {
      method: "POST",
      headers,
      body: { on: true },
    });
    assert.equal(powered.data.plugs.devices[0].on, true);
    assert.equal(tv.on, true);
    await json(origin, "/api/plugs/power", { method: "POST", headers, body: { on: false } });
    assert.equal(tv.on, false);

    const uploaded = await fetch(`${origin}/api/media`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "video/mp4",
        "x-filename": "snow.mp4",
        "x-title": "Snow loop",
        "x-folder": "christmas",
        "x-tags": "snow,christmas",
        "x-all-ages": "true",
      },
      body: Buffer.from("fake-mp4"),
    });
    const library = await uploaded.json();
    assert.equal(uploaded.status, 200);
    const video = library.media.videos[0];
    assert.equal(video.title, "Snow loop");
    assert.equal(video.allAges, true);
    assert.equal(library.playlist.some((card) => card.id === video.id), false);
    const themed = await json(origin, "/api/theme", {
      method: "PUT",
      headers,
      body: { theme: "christmas" },
    });
    assert.equal(themed.data.state.theme, "christmas");
    assert.ok(themed.data.playlist.some((card) => card.id === video.id && card.type === "video"));
    const file = await fetch(`${origin}${video.url}`);
    assert.equal(file.status, 200);

    const played = await json(origin, "/api/media/play", {
      method: "POST",
      headers,
      body: { id: video.id, mode: "span" },
    });
    assert.equal(played.data.playback.mode, "span");
    assert.deepEqual(played.data.playback.slots, ["1", "2", "3"]);
    const stopped = await json(origin, "/api/media/stop", { method: "POST", headers });
    assert.equal(stopped.data.playback, null);

    const mature = await json(origin, `/api/media/${video.id}`, {
      method: "PUT",
      headers,
      body: { allAges: false },
    });
    assert.equal(mature.data.playlist.some((card) => card.id === video.id), false);
    const blocked = await json(origin, "/api/media/play", {
      method: "POST",
      headers,
      body: { id: video.id, mode: "one", slot: "1" },
    });
    assert.equal(blocked.res.status, 400);

    const control = await fetch(`${origin}/admin`);
    const html = await control.text();
    assert.match(html, /Christmas/);
    assert.match(html, /Never put the PC on a plug/);
    const script = await (await fetch(`${origin}/control.js`)).text();
    assert.match(script, /All three/);
  } finally {
    server.close();
  }
});
