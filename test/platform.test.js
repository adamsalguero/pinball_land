const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");
const { migrateData, dataLayout } = require("../src/paths");
const { parseYoutubeInput, embedSrc } = require("../src/youtube");
const { loadCatalog } = require("../src/catalog");
const { classifyImage } = require("../src/resolution");
const { placementDecision, expectedMonitorCount, retryDelay } = require("../src/watchdog");
const { selectRelease, planApply, planRollback, inQuietWindow, swapInstall, rollbackInstall } = require("../src/updater");

async function startServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-platform-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  const { app } = createApp({
    store,
    pin: "2224",
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dir, "opdb"),
    uploadsDir: path.join(dir, "uploads"),
    devicesPath: path.join(dir, "devices.json"),
    guestPhotosDir: path.join(dir, "guest-photos"),
    catalogPath: path.join(root, "media", "catalog.json"),
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}`, dir };
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

test("admin can permanently delete a guest photo", async () => {
  const { server, origin } = await startServer();
  try {
    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#224466" },
    }).jpeg().toBuffer();
    const uploaded = await fetch(`${origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: jpeg,
    });
    const photo = await uploaded.json();
    const headers = { "x-pin": "2224" };
    const removed = await json(origin, `/api/guest-photos/${photo.photo.id}`, { method: "DELETE", headers });
    assert.equal(removed.res.status, 200);
    assert.equal(removed.data.deleted, photo.photo.id);
    const list = await json(origin, "/api/guest-photos", { headers });
    assert.equal((list.data.photos || []).some((item) => item.id === photo.photo.id), false);
    const file = await fetch(`${origin}/media/guest/${photo.photo.id}.jpg`);
    assert.equal(file.status, 404);
  } finally {
    server.close();
  }
});

test("admin login page does not reveal the default PIN", async () => {
  const { server, origin } = await startServer();
  try {
    const admin = await fetch(`${origin}/admin`);
    const html = await admin.text();
    assert.equal(admin.status, 200);
    assert.match(html, /id="pin-input"/);
    assert.doesNotMatch(html, /2224/);
    assert.doesNotMatch(html, /default pin/i);
  } finally {
    server.close();
  }
});

test("guest app is public and admin app is separate", async () => {
  const { server, origin } = await startServer();
  try {
    const guest = await fetch(`${origin}/`);
    const admin = await fetch(`${origin}/admin`);
    const guestText = await guest.text();
    const adminText = await admin.text();
    assert.match(guestText, /Pinball Land/);
    assert.match(guestText, /manifest.webmanifest/);
    assert.doesNotMatch(guestText, /Kiosk control/);
    assert.match(adminText, /Pinball Land Admin/);
    assert.doesNotMatch(adminText, /2224/);
    assert.match(adminText, /admin.webmanifest/);
  } finally {
    server.close();
  }
});

test("guest upload needs no PIN, admin actions need a device token", async () => {
  const { server, origin } = await startServer();
  try {
    const held = await json(origin, "/api/guest-photos/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { autoApprove: false },
    });
    assert.equal(held.res.status, 200);
    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#62006e" },
    }).jpeg().toBuffer();
    const uploaded = await fetch(`${origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-caption": "High score", "x-guest-name": "Ava" },
      body: jpeg,
    });
    const photo = await uploaded.json();
    assert.equal(uploaded.status, 200);
    assert.equal(photo.photo.status, "pending");
    assert.equal(photo.photo.caption, "High score");
    const feed = await json(origin, "/api/guest-photos/feed");
    assert.equal(feed.data.photos.length, 0);
    const denied = await json(origin, `/api/guest-photos/${photo.photo.id}/approve`, { method: "POST" });
    assert.equal(denied.res.status, 401);

    const login = await json(origin, "/api/login", { method: "POST", body: { pin: "2224", name: "Ron iPad" } });
    assert.equal(login.res.status, 200);
    const token = login.data.token;
    assert.ok(token);
    const headers = { "x-device-token": token };
    const approved = await json(origin, `/api/guest-photos/${photo.photo.id}/approve`, { method: "POST", headers });
    assert.equal(approved.data.photo.status, "approved");
    const live = await json(origin, "/api/guest-photos/feed");
    assert.equal(live.data.photos.length, 1);
    assert.match(live.data.photos[0].url, /\/media\/guest\//);

    const changed = await json(origin, "/api/pin", { method: "PUT", headers, body: { pin: "3333" } });
    assert.equal(changed.res.status, 200);
    const oldPin = await json(origin, "/api/login", { method: "POST", body: { pin: "2224" } });
    assert.equal(oldPin.res.status, 401);
    const reset = await json(origin, "/api/pin/reset", { method: "POST", headers });
    assert.equal(reset.data.pin, "2224");
    const again = await json(origin, "/api/login", { method: "POST", body: { pin: "2224", name: "Second" } });
    assert.equal(again.res.status, 200);

    const boot = await json(origin, "/api/admin/bootstrap", { headers: { "x-device-token": again.data.token } });
    const joinToken = new URL(boot.data.joinUrl).searchParams.get("token");
    const joined = await json(origin, "/api/admin/join", { method: "POST", body: { token: joinToken, name: "Joined" } });
    assert.equal(joined.res.status, 200);
    const badJoin = await json(origin, "/api/admin/join", { method: "POST", body: { token: "nope" } });
    assert.equal(badJoin.res.status, 401);

    await json(origin, `/api/devices/${joined.data.device.id}`, {
      method: "DELETE",
      headers: { "x-device-token": again.data.token },
    });
    const revoked = await json(origin, "/api/off", {
      method: "POST",
      headers: { "x-device-token": joined.data.token },
    });
    assert.equal(revoked.res.status, 401);

    await json(origin, "/api/devices/revoke-all", {
      method: "POST",
      headers: { "x-device-token": again.data.token },
    });
    const after = await json(origin, "/api/off", {
      method: "POST",
      headers: { "x-device-token": again.data.token },
    });
    assert.equal(after.res.status, 401);
  } finally {
    server.close();
  }
});

test("internet clients need the wall QR and cannot see admin, state, or displays", async () => {
  const { server, origin } = await startServer();
  const remote = { "x-forwarded-for": "8.8.8.8" };
  try {
    const state = await json(origin, "/api/state", { headers: remote });
    assert.equal(state.res.status, 404);
    const display = await fetch(`${origin}/display/1`, { headers: remote });
    assert.equal(display.status, 404);
    const blocked = await json(origin, "/api/off", { method: "POST", headers: { ...remote, "x-pin": "2224" } });
    assert.equal(blocked.res.status, 404);
    const login = await json(origin, "/api/login", { method: "POST", headers: remote, body: { pin: "2224" } });
    assert.equal(login.res.status, 404);
    const jpeg = await sharp({
      create: { width: 400, height: 300, channels: 3, background: "#2d4c32" },
    }).jpeg().toBuffer();
    const uploaded = await fetch(`${origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-forwarded-for": "8.8.8.8", "x-guest-name": "Sam" },
      body: jpeg,
    });
    const uploadedBody = await uploaded.json();
    assert.equal(uploaded.status, 403);
    assert.match(uploadedBody.error, /Scan the QR code at Pinball Land/);
  } finally {
    server.close();
  }
});

test("repeated wrong PINs lock login, and expired device tokens stop working", async () => {
  const { DeviceStore } = require("../src/devices");
  const { server, origin, dir } = await startServer();
  try {
    for (let i = 0; i < 5; i += 1) {
      const wrong = await json(origin, "/api/login", { method: "POST", body: { pin: "0000" } });
      assert.equal(wrong.res.status, 401);
    }
    const locked = await json(origin, "/api/login", { method: "POST", body: { pin: "2224" } });
    assert.equal(locked.res.status, 429);
    const store = new DeviceStore(path.join(dir, "devices.json"));
    const issued = store.issue("Old iPad");
    store.data.devices[0].createdAt = Date.now() - (401 * 24 * 60 * 60 * 1000);
    assert.equal(store.find(issued.token), null);
  } finally {
    server.close();
  }
});

test("migration copies once and never overwrites the data dir", async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-app-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-data-"));
  await fs.mkdir(path.join(appRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "config.json"), JSON.stringify({ pin: "2224" }));
  await fs.writeFile(path.join(appRoot, "data", "state.json"), "{\"theme\":\"halloween\"}");
  const first = await migrateData({ appRoot, dataDir });
  assert.ok(first.copied.includes("config.json"));
  await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ pin: "9999", note: "keep" }));
  await fs.writeFile(path.join(appRoot, "config.json"), JSON.stringify({ pin: "0000" }));
  const second = await migrateData({ appRoot, dataDir });
  assert.equal(second.already, true);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, "config.json"), "utf8"));
  assert.equal(saved.pin, "9999");
  assert.equal(dataLayout(dataDir).config.endsWith(`${path.sep}config.json`), true);
});

test("reset-pin writes the default PIN and keeps the rest of the config", async () => {
  const { writeDefaultPin } = require("../src/config");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-pin-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ pin: "9999", port: 3000, note: "keep" }));
  writeDefaultPin(configPath);
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.pin, "2224");
  assert.equal(saved.port, 3000);
  assert.equal(saved.note, "keep");
});

test("updater swaps versions and rolls back without touching data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-install-"));
  const data = path.join(root, "data");
  await fs.mkdir(path.join(root, "versions", "1.0.0"), { recursive: true });
  await fs.mkdir(path.join(root, "versions", "1.1.0"), { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, "state.json"), "{\"keep\":true}");
  await swapInstall({ installRoot: root, nextVersion: "1.0.0" });
  await swapInstall({ installRoot: root, nextVersion: "1.1.0" });
  assert.match(await fs.readFile(path.join(root, "current.txt"), "utf8"), /1\.1\.0/);
  assert.equal(planApply({ stagingOk: true, inQuiet: false, force: false }), "wait");
  assert.equal(planApply({ stagingOk: true, inQuiet: false, force: true }), "swap");
  assert.equal(planRollback(false), "rollback");
  const rolled = await rollbackInstall(root);
  assert.equal(rolled.current, "1.0.0");
  const kept = JSON.parse(await fs.readFile(path.join(data, "state.json"), "utf8"));
  assert.equal(kept.keep, true);
  const release = selectRelease([
    { tag_name: "v1.2.0-beta", prerelease: true, draft: false },
    { tag_name: "v1.1.0", prerelease: false, draft: false },
  ]);
  assert.equal(release.tag_name, "v1.1.0");
  assert.equal(inQuietWindow(new Date("2026-10-14T03:00:00"), "02:00", "06:00"), true);
  assert.equal(inQuietWindow(new Date("2026-10-14T12:00:00"), "02:00", "06:00"), false);
});

test("watchdog waits for late monitors and reloads crashed windows", () => {
  assert.equal(expectedMonitorCount({ count: 3, screens: { 1: { enabled: true }, 2: { enabled: false }, 3: { enabled: true } } }), 2);
  const waiting = placementDecision({ seen: 1, expected: 3, signature: "a", previousSignature: "a", windowCount: 1 });
  assert.equal(waiting.ready, false);
  assert.equal(waiting.reopen, true);
  const crashed = placementDecision({ seen: 3, expected: 3, signature: "a", previousSignature: "a", windowCount: 3, crashed: ["2"] });
  assert.deepEqual(crashed.reload, ["2"]);
  assert.ok(retryDelay(4) >= retryDelay(1));
});

test("catalog and youtube inputs are explicit", () => {
  const items = loadCatalog(path.join(__dirname, "..", "media", "catalog.json"));
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.streamUrl.startsWith("https://")));
  assert.ok(items.filter((item) => item.holiday === "christmas").every((item) => item.color === true));
  assert.equal(items.find((item) => item.id === "christmas-comes-1936").holiday, "christmas");
  assert.equal(items.find((item) => item.id === "skeleton-dance-1929").holiday, "halloween");
  assert.equal(items.some((item) => item.id === "a-christmas-carol-1910"), false);
  assert.equal(items.some((item) => item.id === "santas-surprise-1947"), false);
  assert.equal(items.some((item) => item.id === "good-will-to-men-1955"), false);
  assert.equal(items.some((item) => item.id === "swing-you-sinners-1930"), false);
  const video = parseYoutubeInput("https://www.youtube.com/watch?v=abcdefghijk");
  assert.deepEqual(video, { kind: "video", id: "abcdefghijk" });
  const list = parseYoutubeInput("https://www.youtube.com/playlist?list=PLabcdefghijklmnop");
  assert.equal(list.kind, "playlist");
  assert.match(embedSrc(video), /youtube-nocookie\.com\/embed\/abcdefghijk/);
  assert.match(embedSrc(video), /controls=0/);
  assert.match(embedSrc(video), /rel=0/);
  assert.equal(classifyImage({ width: 400, height: 300, guest: true }).mode, "collage");
  assert.equal(classifyImage({ width: 200, height: 100, guest: true }).ok, false);
  assert.equal(classifyImage({ width: 1920, height: 1080 }).mode, "full");
  assert.equal(classifyImage({ width: 800, height: 600 }).mode, "collage");
  assert.equal(parseYoutubeInput('https://youtu.be/abc"><script>'), null);
  const { normalizePhotos } = require("../src/config");
  assert.equal(normalizePhotos({ publicBaseUrl: "javascript:alert(1)" }).publicBaseUrl, "");
  assert.equal(normalizePhotos({ publicBaseUrl: "https://photos.example.com" }).publicBaseUrl, "https://photos.example.com");
});
