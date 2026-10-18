const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");
const { createConfigStore } = require("../src/config");
const { GuestAlbum } = require("../src/photos");
const { checkImage } = require("../src/nsfw");
const { maskProfanity } = require("../src/text-filter");
const {
  guestDay,
  previousDay,
  guestToken,
  tokensFor,
  tokenMatches,
  signGuestCookie,
  readGuestCookie,
  COOKIE_MS,
} = require("../src/guest-link");
const { parseTailscaleStatus, parseFunnelStatus, publicUrlFrom, parseCloudflareLine } = require("../src/public-access");

const HOUR = 60 * 60 * 1000;

async function jpeg(color = "#224466") {
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: color },
  }).jpeg().toBuffer();
}

async function startServer(extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-public-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  const configPath = path.join(dir, "config.json");
  const configStore = createConfigStore(configPath);
  let now = extra.now || Date.UTC(2026, 9, 18, 16, 0, 0);
  const { app, guestApp } = createApp({
    store,
    configStore,
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dir, "opdb"),
    uploadsDir: path.join(dir, "uploads"),
    devicesPath: path.join(dir, "devices.json"),
    guestPhotosDir: path.join(dir, "guest-photos"),
    catalogPath: path.join(root, "media", "catalog.json"),
    clock: () => now,
    publicProbe: extra.publicProbe || (async () => ({ url: "", source: "" })),
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    guestApp,
    port,
    dir,
    configPath,
    guestDir: path.join(dir, "guest-photos"),
    setNow(value) { now = value; },
    now() { return now; },
  };
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

function cookiePair(setCookieLines, name) {
  const line = (setCookieLines || []).find((item) => item.startsWith(`${name}=`));
  if (!line) return "";
  return line.split(";")[0];
}

test("guest day rolls at 4 AM and yesterday's token still works", () => {
  const secret = "venue-guest-secret-value";
  const before = Date.parse("2026-10-18T03:59:00Z");
  const after = Date.parse("2026-10-18T04:00:00Z");
  assert.equal(guestDay(before, "UTC"), "2026-10-17");
  assert.equal(guestDay(after, "UTC"), "2026-10-18");
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  const now = Date.parse("2026-10-18T18:00:00Z");
  const pack = tokensFor(secret, now, "UTC");
  assert.equal(tokenMatches(secret, pack.tokens[0], now, "UTC"), true);
  assert.equal(tokenMatches(secret, pack.tokens[1], now, "UTC"), true);
  const older = guestToken(secret, previousDay(pack.yesterday));
  assert.equal(tokenMatches(secret, older, now, "UTC"), false);
  assert.equal(tokenMatches(secret, "", now, "UTC"), false);
  const exp = now + COOKIE_MS;
  const raw = signGuestCookie(secret, exp);
  assert.ok(readGuestCookie(secret, raw, now));
  assert.ok(readGuestCookie(secret, raw, exp - 1));
  assert.equal(readGuestCookie(secret, raw, exp), null);
  assert.equal(readGuestCookie(secret, `${raw}x`, now), null);
});

test("tailscale status becomes a fixed https URL and cloudflare lines are read", () => {
  const dns = parseTailscaleStatus(JSON.stringify({ Self: { DNSName: "wall.tailnet.ts.net.", Online: true } }));
  assert.equal(publicUrlFrom(dns, true), "https://wall.tailnet.ts.net");
  assert.equal(parseFunnelStatus(JSON.stringify({ Web: { "wall.tailnet.ts.net:443": {} } })), true);
  assert.equal(parseFunnelStatus(JSON.stringify({ AllowFunnel: false })), false);
  assert.equal(parseCloudflareLine("request at https://random-name.trycloudflare.com ready"), "https://random-name.trycloudflare.com");
  assert.equal(parseTailscaleStatus(JSON.stringify({ Self: { DNSName: "offline.example.com", Online: true } })), "");
});

test("internet guests need today's or yesterday's QR, then a 12 hour cookie", async () => {
  const started = await startServer();
  const remote = { "x-forwarded-for": "8.8.8.8" };
  try {
    const secret = JSON.parse(await fs.readFile(started.configPath, "utf8")).guestSecret;
    const pack = tokensFor(secret, started.now());
    const open = await fetch(`${started.origin}/`, { headers: remote, redirect: "manual" });
    assert.equal(open.status, 403);
    assert.match(await open.text(), /Scan the QR code at Pinball Land/);
    const lan = await fetch(`${started.origin}/`);
    assert.equal(lan.status, 200);
    assert.match(await lan.text(), /manifest.webmanifest/);
    const old = await fetch(`${started.origin}/?k=${guestToken(secret, previousDay(pack.yesterday))}`, {
      headers: remote,
      redirect: "manual",
    });
    assert.equal(old.status, 403);
    const yesterday = await fetch(`${started.origin}/?k=${pack.tokens[1]}`, { headers: remote, redirect: "manual" });
    assert.equal(yesterday.status, 302);
    const today = await fetch(`${started.origin}/?k=${pack.tokens[0]}`, { headers: remote, redirect: "manual" });
    assert.equal(today.status, 302);
    assert.equal(today.headers.get("location"), "/");
    const guestCookie = cookiePair(today.headers.getSetCookie(), "pl_guest");
    assert.match(guestCookie, /^pl_guest=/);
    const inside = await fetch(`${started.origin}/`, { headers: { ...remote, cookie: guestCookie } });
    assert.equal(inside.status, 200);
    assert.match(await inside.text(), /Take a photo/);
    started.setNow(started.now() + 11 * HOUR);
    const still = await fetch(`${started.origin}/`, { headers: { ...remote, cookie: guestCookie } });
    assert.equal(still.status, 200);
    started.setNow(started.now() + 2 * HOUR);
    const expired = await fetch(`${started.origin}/`, { headers: { ...remote, cookie: guestCookie } });
    assert.equal(expired.status, 403);
  } finally {
    started.server.close();
  }
});

test("public access uses the funnel URL in the QR and falls back when it is off", async () => {
  const started = await startServer({
    publicProbe: async () => ({ url: "https://pinball.example.ts.net", source: "tailscale" }),
  });
  try {
    const off = await json(started.origin, "/api/state", { headers: { "x-pin": "2224" } });
    assert.equal(off.data.publicAccess.enabled, false);
    assert.equal(String(off.data.guest.publicUrl || "").includes("?k="), false);
    const on = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true },
    });
    assert.equal(on.res.status, 200);
    assert.equal(on.data.publicAccess.url, "https://pinball.example.ts.net");
    assert.match(on.data.guest.publicUrl, /^https:\/\/pinball\.example\.ts\.net\/\?k=/);
    const secret = JSON.parse(await fs.readFile(started.configPath, "utf8")).guestSecret;
    const token = guestToken(secret, guestDay(started.now()));
    assert.equal(on.data.guest.publicUrl, `https://pinball.example.ts.net/?k=${token}`);
    const hidden = await json(started.origin, "/api/state", { headers: { "x-forwarded-for": "1.1.1.1" } });
    assert.equal(hidden.res.status, 404);
  } finally {
    started.server.close();
  }
});

test("photo uploads auto-approve, pause, rate-limit, and strip words", async () => {
  const started = await startServer();
  try {
    const body = await jpeg("#123456");
    const first = await fetch(`${started.origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-caption": encodeURIComponent("nice shot"), "x-guest-name": "Ava" },
      body,
    });
    const approved = await first.json();
    assert.equal(first.status, 200);
    assert.equal(approved.photo.status, "approved");
    const feed = await json(started.origin, "/api/guest-photos/feed");
    assert.equal(feed.data.photos.length, 1);

    await json(started.origin, "/api/guest-photos/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { autoApprove: false },
    });
    const held = await fetch(`${started.origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-caption": encodeURIComponent("oh shit") },
      body,
    });
    const pending = await held.json();
    assert.equal(pending.photo.status, "pending");
    assert.equal(pending.photo.caption.includes("shit"), false);
    assert.match(pending.photo.caption, /oh/);

    for (let i = 0; i < 4; i += 1) {
      const extra = await fetch(`${started.origin}/api/guest-photos`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body,
      });
      assert.equal(extra.status, 200);
    }
    const limited = await fetch(`${started.origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body,
    });
    assert.equal(limited.status, 429);

    await json(started.origin, "/api/guest-photos/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { paused: true },
    });
    const paused = await fetch(`${started.origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body,
    });
    assert.equal(paused.status, 403);
    assert.match((await paused.json()).error, /paused/);
  } finally {
    started.server.close();
  }
});

test("album holds flagged photos, strips exif, and caps the daily count", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-album-"));
  const album = new GuestAlbum({ root: dir });
  const tagged = await sharp({
    create: { width: 1800, height: 1200, channels: 3, background: "#336699" },
  }).jpeg().withMetadata({ exif: { IFD0: { ImageDescription: "secret-gps" } } }).toBuffer();
  assert.ok((await sharp(tagged).metadata()).exif);
  const clean = await album.ingest(tagged, { caption: "hello", guestName: "Sam", autoApprove: true, ip: "exif" });
  assert.ok(clean.width <= 1600);
  assert.ok(clean.height <= 1600);
  const saved = await sharp(path.join(dir, "files", `${clean.id}.jpg`)).metadata();
  assert.equal(saved.exif, undefined);
  const held = await album.ingest(await jpeg(), {
    autoApprove: true,
    ip: "nsfw",
    nsfw: async () => ({ checked: true, flagged: true }),
  });
  assert.equal(held.status, "pending");
  const start = Date.UTC(2026, 9, 18, 12, 0, 0);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(album.allow("day", start + i * 11 * 60 * 1000), true);
  }
  assert.equal(album.allow("day", start + 30 * 11 * 60 * 1000), false);
  const scan = await checkImage(Buffer.from("not-a-model"));
  assert.deepEqual(scan, { checked: false, flagged: false });
  assert.equal(maskProfanity("oh shit").includes("shit"), false);
});

test("pinboard off leaves rotation and rejects a pinboard slot", async () => {
  const started = await startServer();
  try {
    const before = await json(started.origin, "/api/state", { headers: { "x-pin": "2224" } });
    assert.equal(before.data.playlist.some((card) => card.type === "pinboard"), true);
    assert.equal(before.data.guest.pinboard, true);
    const off = await json(started.origin, "/api/guest-photos/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { pinboard: false },
    });
    assert.equal(off.data.guest.pinboard, false);
    assert.equal(off.data.playlist.some((card) => card.type === "pinboard"), false);
    assert.equal(off.data.state.rotation.items.pinboard, false);
    const slot = await json(started.origin, "/api/slots/1", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { content: "pinboard" },
    });
    assert.equal(slot.res.status, 400);
  } finally {
    started.server.close();
  }
});

test("a tunnel gets 404 for admin and a LAN cookie post still needs CSRF", async () => {
  const started = await startServer();
  const remote = { "x-forwarded-for": "8.8.8.8" };
  try {
    const changed = await json(started.origin, "/api/pin", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { pin: "123456" },
    });
    assert.equal(changed.res.status, 200);
    const tunneled = await json(started.origin, "/api/login", {
      method: "POST",
      headers: remote,
      body: { pin: "123456" },
    });
    assert.equal(tunneled.res.status, 404);
    const admin = await fetch(`${started.origin}/admin`, { headers: { "cf-ray": "test", "cf-connecting-ip": "8.8.8.8" } });
    assert.equal(admin.status, 404);
    const display = await fetch(`${started.origin}/display/1`, { headers: { "tailscale-funnel-request": "true" } });
    assert.equal(display.status, 404);
    const cdn = await fetch(`${started.origin}/api/state`, { headers: { "cdn-loop": "cloudflare; loops=1" } });
    assert.equal(cdn.status, 404);
    const forwarded = await fetch(`${started.origin}/api/plugs/power`, {
      method: "POST",
      headers: { "content-type": "application/json", forwarded: "for=8.8.8.8" },
      body: JSON.stringify({ on: true }),
    });
    assert.equal(forwarded.status, 404);

    const lan = await fetch(`${started.origin}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: "123456", name: "iPad" }),
    });
    const lanLines = lan.headers.getSetCookie();
    const device = cookiePair(lanLines, "pl_device");
    const csrf = cookiePair(lanLines, "pl_csrf");
    const bare = await fetch(`${started.origin}/api/off`, {
      method: "POST",
      headers: { cookie: device },
    });
    assert.equal(bare.status, 403);
    const forged = await fetch(`${started.origin}/api/off`, {
      method: "POST",
      headers: { cookie: `${device}; ${csrf}`, "x-csrf": csrf.split("=")[1], origin: "https://evil.example" },
    });
    assert.equal(forged.status, 403);
    const ok = await fetch(`${started.origin}/api/off`, {
      method: "POST",
      headers: { cookie: `${device}; ${csrf}`, "x-csrf": decodeURIComponent(csrf.split("=")[1]) },
    });
    assert.equal(ok.status, 200);
  } finally {
    started.server.close();
  }
});

function statusOf(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a public host and the guest port hide admin, state, and displays", async () => {
  const started = await startServer();
  const guest = http.createServer(started.guestApp);
  await new Promise((resolve) => guest.listen(0, "127.0.0.1", resolve));
  const guestPort = guest.address().port;
  try {
    assert.equal(await statusOf(started.port, "/admin", { host: "wall.tailnet.ts.net" }), 404);
    assert.equal(await statusOf(started.port, "/api/state", { host: "random-name.trycloudflare.com" }), 404);
    assert.equal(await statusOf(started.port, "/display/2", { host: "8.8.8.8" }), 404);
    assert.equal(await statusOf(started.port, "/admin", { host: `127.0.0.1:${started.port}` }), 200);
    assert.equal(await statusOf(started.port, "/display/1", { host: "pinball-pc" }), 200);
    assert.equal(await statusOf(guestPort, "/admin", { host: "127.0.0.1" }), 404);
    assert.equal(await statusOf(guestPort, "/api/state", { host: "127.0.0.1" }), 404);
    assert.equal(await statusOf(guestPort, "/display/1", { host: "127.0.0.1" }), 404);
    assert.equal(await statusOf(guestPort, "/", { host: "127.0.0.1" }), 403);
    const guestHome = await fetch(`http://127.0.0.1:${guestPort}/api/guest`);
    assert.equal(guestHome.status, 403);
  } finally {
    guest.close();
    started.server.close();
  }
});

test("enable-public-access script installs Tailscale and keeps Funnel in the background", async () => {
  const text = await fs.readFile(path.join(__dirname, "..", "scripts", "enable-public-access.ps1"), "utf8");
  assert.match(text, /winget/);
  assert.match(text, /tailscale-setup-latest-amd64\.msi/);
  assert.match(text, /tailscale up/);
  assert.match(text, /funnel --bg/);
  assert.match(text, /\$Port = 3010/);
});
