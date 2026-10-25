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
const {
  parseTailscaleStatus,
  parseFunnelStatus,
  publicUrlFrom,
  parseCloudflareLine,
  parseFunnelApprovalUrl,
  detectTailscale,
} = require("../src/public-access");

const HOUR = 60 * 60 * 1000;

async function jpeg(color = "#224466") {
  return sharp({
    create: { width: 400, height: 300, channels: 3, background: color },
  }).jpeg().toBuffer();
}

async function phoneJpeg() {
  const width = 1200;
  const height = 1600;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    const n = i / 3;
    raw[i] = n & 255;
    raw[i + 1] = (n >> 3) & 255;
    raw[i + 2] = (n * 5) & 255;
  }
  let body = null;
  for (const quality of [42, 55, 70, 85]) {
    body = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
    if (body.length >= 200 * 1024 && body.length <= 800 * 1024) return body;
  }
  return body;
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
    tunnelImpl: extra.tunnelImpl || null,
    probeFetch: extra.probeFetch || null,
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
  const approval = "https://login.tailscale.com/f/funnel?node=n123";
  assert.equal(parseFunnelApprovalUrl(`Funnel is not enabled.\nTo enable, visit:\n\t${approval}`), approval);
  assert.equal(parseFunnelApprovalUrl("https://wall.tailnet.ts.net"), "");
});

test("tailscale installed without funnel reports the approval link and does not invent a URL", async () => {
  const dns = JSON.stringify({ BackendState: "Running", Self: { DNSName: "wall.tailnet.ts.net.", Online: true } });
  const funnelOff = JSON.stringify({ AllowFunnel: false });
  const approval = "https://login.tailscale.com/f/funnel?node=n123";
  const found = await detectTailscale(async (command, args) => {
    assert.equal(command, "tailscale");
    if (args[0] === "status") return dns;
    if (args.includes("--json")) return funnelOff;
    return `Funnel is not enabled on your tailnet.\n${approval}\n`;
  });
  assert.equal(found.installed, true);
  assert.equal(found.loggedIn, true);
  assert.equal(found.url, "");
  assert.equal(found.approvalUrl, approval);
  const missing = await detectTailscale(async () => "");
  assert.equal(missing.installed, false);
  assert.equal(missing.url, "");
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

function assertNoPrivateGuestHost(value) {
  const text = String(value || "");
  assert.equal(/100\.\d+\.\d+\.\d+/.test(text), false, text);
  assert.equal(/\.ts\.net/i.test(text), false, text);
  assert.equal(/localhost|127\.0\.0\.1|\[::1\]/i.test(text), false, text);
  assert.equal(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+\b/.test(text), false, text);
}

function fakeHeaders(map = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(map)) lower[key.toLowerCase()] = value;
  return { get(name) { return lower[String(name).toLowerCase()] || null; } };
}

test("public access stays off the wall until Cloudflare answers", async () => {
  const started = await startServer();
  try {
    const off = await json(started.origin, "/api/state", { headers: { "x-pin": "2224" } });
    assert.equal(off.data.publicAccess.enabled, false);
    assert.equal(off.data.guest.publicUrl || null, null);
    assert.equal(off.data.guest.scoreUrl || null, null);
    const on = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true },
    });
    assert.equal(on.res.status, 200);
    assert.equal(on.data.publicAccess.url, "");
    assert.equal(on.data.guest.publicUrl || null, null);
    assert.equal(on.data.guest.scoreUrl || null, null);
    assert.match(on.data.publicAccess.detail, /Cloudflare is off while tests are running/);
    assertNoPrivateGuestHost(JSON.stringify(on.data.guest));
    assertNoPrivateGuestHost(on.data.publicAccess.url);
    const hidden = await json(started.origin, "/api/state", { headers: { "x-forwarded-for": "1.1.1.1" } });
    assert.equal(hidden.res.status, 404);
  } finally {
    started.server.close();
  }
});

test("wall QRs use only a verified Cloudflare URL and appear together", async () => {
  let tunnelUrl = "";
  let starts = 0;
  const fetched = [];
  let phase = "down";
  const tunnelImpl = {
    start() {
      starts += 1;
      if (!tunnelUrl) tunnelUrl = "https://pinball-guest.trycloudflare.com";
    },
    stop() {
      tunnelUrl = "";
    },
    status() {
      return {
        url: tunnelUrl,
        detail: tunnelUrl
          ? `Cloudflare is up. Guests use ${tunnelUrl}`
          : "Cloudflare is starting. The guest link will show here when it is ready.",
      };
    },
  };
  const probeFetch = async (url, options = {}) => {
    const target = String(url);
    fetched.push(target);
    const parsed = new URL(target);
    assert.equal(parsed.protocol, "https:");
    assert.match(parsed.hostname, /^[a-z0-9-]+\.trycloudflare\.com$/);
    assertNoPrivateGuestHost(target);
    if (phase === "down") return { status: 503, headers: fakeHeaders() };
    if (phase === "fail") return { status: 403, headers: fakeHeaders() };
    const allowed = phase === "moved" ? "party-guest.trycloudflare.com" : "pinball-guest.trycloudflare.com";
    if (parsed.hostname !== allowed) return { status: 502, headers: fakeHeaders() };
    if (parsed.searchParams.get("k")) {
      return {
        status: 302,
        headers: fakeHeaders({ location: "/", "set-cookie": "pl_guest=ok; Path=/" }),
      };
    }
    const cookie = options.headers?.cookie || "";
    if (cookie.includes("pl_guest=ok") && parsed.pathname === "/") {
      return { status: 200, headers: fakeHeaders() };
    }
    return { status: 403, headers: fakeHeaders() };
  };
  const started = await startServer({ tunnelImpl, probeFetch });
  const qrcode = require("qrcode");
  const original = qrcode.toBuffer;
  const encoded = [];
  qrcode.toBuffer = async (text, options) => {
    encoded.push(text);
    return original.call(qrcode, text, options);
  };
  const boardToken = "11111111-1111-4111-8111-111111111111";
  const forbidden = [
    "http://100.117.20.93:3010",
    "https://pinball.example.ts.net",
    "http://127.0.0.1:3010",
    "http://192.168.1.20:3010",
    "http://10.0.0.8:3010",
  ];
  try {
    const blocked = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true, cloudflare: false },
    });
    assert.equal(blocked.res.status, 200);
    assert.ok(starts >= 1);
    assert.equal(blocked.data.publicAccess.url, "");
    assert.equal(blocked.data.guest.publicUrl || null, null);
    assert.equal(blocked.data.guest.scoreUrl || null, null);
    assert.equal(fetched.length > 0, true);
    const guestHidden = await fetch(`${started.origin}/api/guest-qr`);
    const scoreHidden = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`);
    assert.equal(guestHidden.status, 404);
    assert.equal(scoreHidden.status, 404);
    assert.equal(encoded.length, 0);
    assertNoPrivateGuestHost(JSON.stringify(blocked.data.guest));
    assertNoPrivateGuestHost(blocked.data.publicAccess.detail);

    for (const bad of forbidden) {
      const before = fetched.length;
      tunnelUrl = bad;
      const refused = await json(started.origin, "/api/public-access", {
        method: "PUT",
        headers: { "x-pin": "2224" },
        body: { enabled: true },
      });
      assert.equal(refused.data.guest.publicUrl || null, null);
      assert.equal(refused.data.guest.scoreUrl || null, null);
      assert.equal(fetched.length, before);
      assert.equal(encoded.length, 0);
    }

    phase = "ok";
    tunnelUrl = "https://pinball-guest.trycloudflare.com";
    const ready = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true },
    });
    const secret = JSON.parse(await fs.readFile(started.configPath, "utf8")).guestSecret;
    const token = guestToken(secret, guestDay(started.now()));
    const guestUrl = `https://pinball-guest.trycloudflare.com/?k=${token}`;
    assert.equal(ready.data.publicAccess.url, "https://pinball-guest.trycloudflare.com");
    assert.equal(ready.data.publicAccess.source, "cloudflare");
    assert.equal(ready.data.guest.publicUrl, guestUrl);
    assert.equal(ready.data.guest.scoreUrl, guestUrl);
    assert.match(ready.data.publicAccess.detail, /Cloudflare is up/);
    const guestQr = await fetch(`${started.origin}/api/guest-qr`);
    const scoreQr = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`);
    assert.equal(guestQr.status, 200);
    assert.equal(scoreQr.status, 200);
    assert.match(guestQr.headers.get("content-type") || "", /image\/png/);
    assert.match(scoreQr.headers.get("content-type") || "", /image\/png/);
    assert.equal(encoded.at(-2), guestUrl);
    const scoreLink = new URL(encoded.at(-1));
    assert.equal(scoreLink.origin, "https://pinball-guest.trycloudflare.com");
    assert.equal(scoreLink.searchParams.get("k"), token);
    assert.equal(scoreLink.searchParams.get("tab"), "scores");
    assert.equal(scoreLink.searchParams.get("board"), boardToken);
    for (const text of encoded) assertNoPrivateGuestHost(text);
    const beforeRemote = encoded.length;
    const remoteGuest = await fetch(`${started.origin}/api/guest-qr`, { headers: { "x-forwarded-for": "8.8.8.8" } });
    const remoteScore = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`, { headers: { "x-forwarded-for": "8.8.8.8" } });
    assert.equal(remoteGuest.status, 404);
    assert.equal(remoteScore.status, 404);
    assert.equal(encoded.length, beforeRemote);

    phase = "fail";
    const dropped = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true },
    });
    assert.equal(dropped.data.publicAccess.url, "");
    assert.equal(dropped.data.guest.publicUrl || null, null);
    assert.equal(dropped.data.guest.scoreUrl || null, null);
    assert.equal((await fetch(`${started.origin}/api/guest-qr`)).status, 404);
    assert.equal((await fetch(`${started.origin}/api/score-qr?board=${boardToken}`)).status, 404);

    phase = "moved";
    tunnelUrl = "https://party-guest.trycloudflare.com";
    const moved = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true },
    });
    const movedUrl = `https://party-guest.trycloudflare.com/?k=${token}`;
    assert.equal(moved.data.guest.publicUrl, movedUrl);
    assert.equal(moved.data.guest.scoreUrl, movedUrl);
    assert.equal(String(moved.data.guest.publicUrl).includes("pinball-guest"), false);
    await fetch(`${started.origin}/api/guest-qr`);
    await fetch(`${started.origin}/api/score-qr?board=${boardToken}`);
    assert.equal(encoded.at(-2), movedUrl);
    const movedScore = new URL(encoded.at(-1));
    assert.equal(movedScore.origin, "https://party-guest.trycloudflare.com");
    assert.equal(movedScore.searchParams.get("tab"), "scores");
    assert.equal(movedScore.searchParams.get("board"), boardToken);
    assert.equal(movedScore.searchParams.get("k"), token);
    for (const text of encoded) assertNoPrivateGuestHost(text);
  } finally {
    qrcode.toBuffer = original;
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

test("album strips exif, approves clean photos, and caps the daily count", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-album-"));
  const album = new GuestAlbum({ root: dir });
  const tagged = await sharp({
    create: { width: 1800, height: 1200, channels: 3, background: "#336699" },
  }).jpeg().withMetadata({ exif: { IFD0: { ImageDescription: "secret-gps" } } }).toBuffer();
  assert.ok((await sharp(tagged).metadata()).exif);
  const clean = await album.ingest(tagged, { caption: "hello", guestName: "Sam", autoApprove: true, ip: "exif" });
  assert.equal(clean.status, "approved");
  assert.ok(clean.width <= 1600);
  assert.ok(clean.height <= 1600);
  const saved = await sharp(path.join(dir, "files", `${clean.id}.jpg`)).metadata();
  assert.equal(saved.exif, undefined);
  const held = await album.ingest(await jpeg(), { autoApprove: false, ip: "review" });
  assert.equal(held.status, "pending");
  const start = Date.UTC(2026, 9, 18, 12, 0, 0);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(album.allow("day", start + i * 11 * 60 * 1000), true);
  }
  assert.equal(album.allow("day", start + 30 * 11 * 60 * 1000), false);
  assert.equal(maskProfanity("oh shit").includes("shit"), false);
  assert.equal(require("node:fs").existsSync(path.join(__dirname, "..", "src", "nsfw.js")), false);
});

test("a phone photo leaves admin and guest responding", async () => {
  const started = await startServer();
  try {
    const body = await phoneJpeg();
    assert.ok(body.length >= 200 * 1024 && body.length <= 800 * 1024, `jpeg bytes ${body.length}`);
    const posted = await fetch(`${started.origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-guest-name": "Sam", "x-caption": "Wall" },
      body,
    });
    assert.equal(posted.status, 200);
    const photo = await posted.json();
    assert.equal(photo.photo.status, "approved");
    const admin = await fetch(`${started.origin}/admin`);
    assert.equal(admin.status, 200);
    const adminHtml = await admin.text();
    assert.match(adminHtml, /id="app"/);
    assert.match(adminHtml, /control\.js/);
    const guestPage = await fetch(`${started.origin}/`);
    assert.equal(guestPage.status, 200);
    const guestHtml = await guestPage.text();
    assert.match(guestHtml, /Pinball Land/);
    assert.match(guestHtml, /guest\.js/);
    const state = await json(started.origin, "/api/state");
    assert.equal(state.res.status, 200);
    assert.ok(Array.isArray(state.data.state.leaderboards));
    assert.equal(state.data.guest.photos.length, 1);
    const guestApi = await json(started.origin, "/api/guest");
    assert.equal(guestApi.res.status, 200);
    assert.equal(guestApi.data.guest.pinboard, true);
    const feed = await json(started.origin, "/api/guest-photos/feed");
    assert.equal(feed.res.status, 200);
    assert.equal(feed.data.photos.length, 1);
    const image = await fetch(`${started.origin}${feed.data.photos[0].url}`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type") || "", /jpeg/);
    const display = await fetch(`${started.origin}/display/1`);
    assert.equal(display.status, 200);
    assert.match(await display.text(), /display\.js/);
  } finally {
    started.server.close();
  }
});

test("approved photos stay in auto rotation before the cloudflare QR verifies", async () => {
  const { planRotation, rotationKey } = require("../src/playlist");
  const started = await startServer();
  try {
    const posted = await fetch(`${started.origin}/api/guest-photos`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-caption": "party", "x-guest-name": "Ada" },
      body: await jpeg("#446688"),
    });
    assert.equal(posted.status, 200);
    await json(started.origin, "/api/rotation", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { items: { pinboard: false } },
    });
    const on = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true },
    });
    assert.equal(on.data.guest.pinboard, true);
    assert.equal(on.data.guest.publicUrl || null, null);
    assert.equal(on.data.guest.scoreUrl || null, null);
    assert.equal(on.data.guest.photos.some((photo) => photo.status === "approved"), true);
    assert.equal(on.data.state.rotation.items.pinboard, true);
    assert.equal(on.data.playlist.some((card) => card.type === "pinboard"), true);
    const layout = {
      1: { content: "rotation", enabled: true },
      2: { content: "rotation", enabled: true },
      3: { content: "rotation", enabled: true },
    };
    let saw = false;
    for (let tick = 0; tick < on.data.playlist.length; tick += 1) {
      const plan = planRotation(on.data.playlist, {
        startedAt: 0,
        intervalSec: 30,
        screenCount: 3,
        layout,
        now: tick * 30000,
      });
      if (["1", "2", "3"].some((slot) => rotationKey(plan[slot]) === "pinboard")) saw = true;
    }
    assert.equal(saw, true);
    assert.equal((await fetch(`${started.origin}/api/guest-qr`)).status, 404);
    assert.equal((await fetch(`${started.origin}/api/score-qr?board=11111111-1111-4111-8111-111111111111`)).status, 404);
  } finally {
    started.server.close();
  }
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
    const on = await json(started.origin, "/api/guest-photos/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { pinboard: true },
    });
    assert.equal(on.data.guest.pinboard, true);
    assert.equal(on.data.state.rotation.items.pinboard, true);
    assert.equal(on.data.playlist.some((card) => card.type === "pinboard"), true);
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

test("score QR deep-links the public guest app and scores stay pending until auto-approve", async () => {
  const { loadConfig, normalizeScores, normalizePhotos } = require("../src/config");
  assert.equal(normalizeScores(undefined).autoApprove, false);
  assert.equal(normalizeScores({}).autoApprove, false);
  assert.equal(normalizeScores({ autoApprove: "yes" }).autoApprove, false);
  assert.equal(normalizeScores({ autoApprove: true }).autoApprove, true);
  assert.equal(normalizePhotos({}).autoApprove, true);
  const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-scores-"));
  const barePath = path.join(bareDir, "config.json");
  await fs.writeFile(barePath, `${JSON.stringify({ pin: "2224", port: 3000 })}\n`);
  const bare = loadConfig(barePath);
  assert.equal(bare.scores.autoApprove, false);
  assert.equal(bare.photos.autoApprove, true);

  const started = await startServer();
  const qrcode = require("qrcode");
  const original = qrcode.toBuffer;
  const encoded = [];
  qrcode.toBuffer = async (text, options) => {
    encoded.push(text);
    return original.call(qrcode, text, options);
  };
  const boardToken = "11111111-1111-4111-8111-111111111111";
  try {
    const hidden = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`);
    assert.equal(hidden.status, 404);
    assert.equal(await hidden.text(), "");
    const initial = await json(started.origin, "/api/state", { headers: { "x-pin": "2224" } });
    assert.equal(initial.data.scores.autoApprove, false);
    assert.equal(initial.data.guest.autoApprove, true);
    assert.equal(initial.data.guest.scoreUrl || null, null);

    await json(started.origin, "/api/guest-photos/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { publicBaseUrl: "http://10.0.0.8:3010" },
    });
    const lanQr = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`);
    assert.equal(lanQr.status, 404);
    assert.equal(await lanQr.text(), "");
    assert.equal(encoded.length, 0);

    await json(started.origin, "/api/guest-photos/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { publicBaseUrl: "https://guests.example.com" },
    });
    const baseQr = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`);
    assert.equal(baseQr.status, 404);
    assert.equal(await baseQr.text(), "");
    assert.equal(encoded.length, 0);

    const enabled = await json(started.origin, "/api/public-access", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { enabled: true },
    });
    assert.equal(enabled.data.guest.scoreUrl || null, null);
    assert.equal(enabled.data.guest.publicUrl || null, null);
    const funnelQr = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`);
    assert.equal(funnelQr.status, 404);
    assert.equal(encoded.length, 0);
    const remote = await fetch(`${started.origin}/api/score-qr?board=${boardToken}`, {
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    assert.equal(remote.status, 404);

    const added = await json(started.origin, "/api/machines", {
      method: "POST",
      headers: { "x-pin": "2224" },
      body: { name: "QR Machine", opdbId: "GTEST-QR" },
    });
    assert.equal(added.res.status, 200, JSON.stringify(added.data));
    const machine = added.data.state.leaderboards.at(-1);
    const pending = await json(started.origin, "/api/scores", {
      method: "POST",
      body: { boardId: machine.id, name: "Casey", score: "4200" },
    });
    assert.equal(pending.res.status, 200);
    assert.equal(pending.data.submission.status, "pending");
    const waiting = await json(started.origin, "/api/state", { headers: { "x-pin": "2224" } });
    const waitingBoard = waiting.data.state.leaderboards.find((item) => item.id === machine.id);
    assert.equal(waitingBoard.rows.length, 0);
    assert.equal(waiting.data.state.scoreSubmissions.some((row) => row.name === "Casey" && row.status === "pending"), true);
    assert.equal(waiting.data.guest.autoApprove, true);

    const turnedOn = await json(started.origin, "/api/scores/settings", {
      method: "PUT",
      headers: { "x-pin": "2224" },
      body: { autoApprove: true },
    });
    assert.equal(turnedOn.data.scores.autoApprove, true);
    assert.equal(turnedOn.data.guest.autoApprove, true);
    const posted = await json(started.origin, "/api/scores", {
      method: "POST",
      body: { boardId: machine.id, name: "Drew", score: "8800" },
    });
    assert.equal(posted.data.submission.status, "approved");
    const live = await json(started.origin, "/api/state", { headers: { "x-pin": "2224" } });
    const liveBoard = live.data.state.leaderboards.find((item) => item.id === machine.id);
    assert.equal(liveBoard.rows.some((row) => row.name === "Drew" && row.score === 8800), true);
    assert.equal(live.data.state.scoreSubmissions.some((row) => row.name === "Drew" && row.status === "pending"), false);
    assert.equal(live.data.guest.autoApprove, true);
    const saved = JSON.parse(await fs.readFile(started.configPath, "utf8"));
    assert.equal(saved.scores.autoApprove, true);
    assert.equal(saved.photos.autoApprove, true);
  } finally {
    qrcode.toBuffer = original;
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
