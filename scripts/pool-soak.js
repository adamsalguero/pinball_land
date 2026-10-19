const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");
const { createApp } = require("../src/app");
const { Store } = require("../src/store");
const { bindDisplayServers } = require("../src/server");

const FLAGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-background-media-suspend",
  "--disable-features=CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-dev-shm-usage",
  "--disable-accelerated-video-decode",
  "--no-sandbox",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function note(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  fs.appendFileSync("/tmp/pool-soak.log", text);
  console.log(text.trim());
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.split("\n").filter(Boolean).slice(-6).join(" ") || `${bin} ${code}`));
      else resolve();
    });
  });
}

async function waitFor(url, attempts = 40) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw last || new Error(`timed out waiting for ${url}`);
}

async function makeClip(dest) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=426x240:r=12:d=16,noise=alls=40:allf=t+u",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-crf", "18",
    "-an", "-movflags", "+faststart",
    dest,
  ]);
  const size = fs.statSync(dest).size;
  if (size < 4 * 1024 * 1024) throw new Error(`clip ${dest} is ${size} bytes, need more than 4 MB`);
}

async function runPoolSoak() {
  const minutes = Number(process.env.PINBALL_POOL_SOAK_MINUTES || 15);
  const durationMs = Number(process.env.PINBALL_POOL_SOAK_MS || minutes * 60 * 1000);
  const swapMs = Number(process.env.PINBALL_POOL_SWAP_MS || 45000);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-pool-"));
  const media = path.join(dir, "media");
  const library = path.join(media, "halloween");
  await fsp.mkdir(library, { recursive: true });
  const items = [];
  for (let i = 0; i < 5; i += 1) {
    const id = crypto.randomUUID();
    const file = path.join(library, `${id}.mp4`);
    note(`encoding clip ${i + 1}`);
    await makeClip(file);
    items.push({
      id,
      title: `Clip ${i + 1}`,
      file: `${id}.mp4`,
      folder: "halloween",
      tags: ["halloween"],
      tags: [],
      allAges: true,
      inRotation: true,
      loop: false,
      bytes: fs.statSync(file).size,
      durationSec: 16,
      addedAt: Date.now(),
    });
  }
  await fsp.writeFile(path.join(media, "library.json"), JSON.stringify({ items }));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  const { app, attachWebSocket } = createApp({
    store,
    pin: "2224",
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dir, "opdb"),
    mediaDir: media,
    mediaCatalog: path.join(media, "library.json"),
    dataDir: dir,
    clipCache: false,
  });
  const bound = await bindDisplayServers(app, { port: 0, attach: attachWebSocket });
  const origins = bound.displayOrigins;
  const healthOrigin = origins[2];
  const chromePath = process.env.PINBALL_CHROME || "/usr/bin/google-chrome";
  const profile = path.join(dir, "chrome-profile");
  const debugPort = 9341;
  const children = [];
  let browser = null;
  try {
    const pin = { "x-pin": "2224", "content-type": "application/json" };
    const themed = await fetch(`${healthOrigin}/api/theme`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({ theme: "halloween" }),
    });
    if (!themed.ok) throw new Error(`theme ${themed.status}`);
    const pinned = await fetch(`${healthOrigin}/api/displays`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({
        count: 3,
        screens: {
          1: { content: "video", enabled: true },
          2: { content: "video", enabled: true },
          3: { content: "video", enabled: true },
        },
      }),
    });
    if (!pinned.ok) throw new Error(`displays ${pinned.status}`);
    const positions = [[0, 0], [80, 60], [160, 120]];
    const slots = [1, 2, 3];
    const first = spawn(chromePath, [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      `--app=${origins[1]}/display/1`,
      `--window-position=${positions[0][0]},${positions[0][1]}`,
      "--window-size=1100,700",
      ...FLAGS,
    ], { stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" } });
    children.push(first);
    await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
    for (const slot of [2, 3]) {
      const [x, y] = positions[slot - 1];
      const child = spawn(chromePath, [
        `--user-data-dir=${profile}`,
        `--app=${origins[slot]}/display/${slot}`,
        `--window-position=${x},${y}`,
        "--window-size=1100,700",
        ...FLAGS,
      ], { stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" } });
      children.push(child);
    }
    await sleep(1500);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    let pages = browser.contexts().flatMap((context) => context.pages());
    if (pages.length < 3) {
      const context = browser.contexts()[0];
      const client = await context.newCDPSession(pages[0] || await context.newPage());
      for (const slot of slots) {
        const wanted = `/display/${slot}`;
        if (pages.some((page) => page.url().includes(wanted))) continue;
        await client.send("Target.createTarget", { url: `${origins[slot]}/display/${slot}`, newWindow: true });
      }
      await sleep(1000);
      pages = browser.contexts().flatMap((context) => context.pages());
    }
    const bySlot = {};
    for (const slot of slots) {
      const page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes(`/display/${slot}`));
      if (!page) throw new Error(`display ${slot} did not open. pages=${browser.contexts().flatMap((context) => context.pages()).map((item) => item.url()).join(" ")}`);
      bySlot[slot] = page;
    }
    const hosts = new Set(slots.map((slot) => new URL(bySlot[slot].url()).host));
    if (hosts.size !== 3) throw new Error(`expected 3 origins, got ${[...hosts].join(" ")}`);
    const tracks = {
      1: { last: null, moved: Date.now() },
      2: { last: null, moved: Date.now() },
      3: { last: null, moved: Date.now() },
    };
    const started = Date.now();
    let nextSwap = started + swapMs;
    let maxOpen = 0;
    while (Date.now() - started < durationMs) {
      const health = await (await fetch(`${healthOrigin}/api/health`)).json();
      maxOpen = Math.max(maxOpen, Number(health.openMedia) || 0, Number(health.maxOpenMedia) || 0);
      if (Number(health.longestMediaMs) > 12000) {
        throw new Error(`a media response stayed open for ${health.longestMediaMs}ms`);
      }
      if (maxOpen > 9) throw new Error(`open media sockets climbed to ${maxOpen}`);
      for (const slot of slots) {
        const sample = await bySlot[slot].evaluate(() => {
          const video = document.getElementById("wall-video");
          return {
            time: Number(video?.currentTime) || 0,
            ready: Number(video?.readyState) || 0,
            paused: Boolean(video?.paused),
            mode: document.getElementById("screen")?.dataset?.mode || "",
            src: video?.currentSrc || video?.getAttribute("src") || "",
          };
        });
        const track = tracks[slot];
        const grace = Date.now() - started < 30000 || Date.now() < track.graceUntil;
        if (sample.mode !== "video") {
          track.moved = Date.now();
          track.last = 0;
          continue;
        }
        if (sample.mode === "video" && sample.src && sample.time > (track.last || 0) + 0.3) {
          track.moved = Date.now();
        }
        if (track.last != null && sample.time + 0.5 < track.last) track.moved = Date.now();
        track.last = sample.time;
        if (!grace && Date.now() - track.moved > 25000) {
          throw new Error(`display ${slot} stopped advancing at ${sample.time.toFixed(2)} ready=${sample.ready} paused=${sample.paused} mode=${sample.mode}`);
        }
      }
      if (Date.now() >= nextSwap) {
        nextSwap = Date.now() + swapMs;
        for (const slot of slots) {
          const id = items.find((item) => (tracks[slot].src || "").includes(item.id))?.id;
          const sampleSrc = await bySlot[slot].evaluate(() => document.getElementById("wall-video")?.currentSrc || "");
          tracks[slot].src = sampleSrc;
          const clipId = items.find((item) => sampleSrc.includes(item.id))?.id || id;
          if (!clipId) continue;
          await fetch(`${healthOrigin}/api/media/failure`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ event: "ended", slot: String(slot), id: clipId, currentTime: tracks[slot].last, src: sampleSrc }),
          });
          tracks[slot].graceUntil = Date.now() + 20000;
          tracks[slot].moved = Date.now();
        }
        note(`swapped at ${Math.round((Date.now() - started) / 1000)}s openMedia=${health.openMedia} max=${health.maxOpenMedia} longest=${health.longestMediaMs}`);
      }
      if (Math.round((Date.now() - started) / 1000) % 30 < 3) {
        note(`t=${Math.round((Date.now() - started) / 1000)}s open=${health.openMedia} max=${health.maxOpenMedia} longest=${health.longestMediaMs} times=${slots.map((slot) => tracks[slot].last?.toFixed(1)).join(",")}`);
      }
      await sleep(2000);
    }
    const health = await (await fetch(`${healthOrigin}/api/health`)).json();
    if (Number(health.longestMediaMs) > 12000) throw new Error(`longest media response ${health.longestMediaMs}ms`);
    if (Number(health.maxOpenMedia) > 9) throw new Error(`max open media ${health.maxOpenMedia}`);
    if (!Number(health.maxOpenMedia)) throw new Error("no media response was tracked");
    note(`done maxOpen=${health.maxOpenMedia} longest=${health.longestMediaMs}`);
    return { maxOpenMedia: health.maxOpenMedia, longestMediaMs: health.longestMediaMs, ms: durationMs };
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of children) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    await Promise.all(bound.servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

module.exports = { runPoolSoak };

if (require.main === module) {
  runPoolSoak().then((result) => {
    console.log(JSON.stringify(result));
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
