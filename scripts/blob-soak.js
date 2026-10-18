const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");
const ffmpeg = require("ffmpeg-static");
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
  "--no-sandbox",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function note(line) {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
}

function chromePath() {
  if (process.env.PINBALL_CHROME && fs.existsSync(process.env.PINBALL_CHROME)) return process.env.PINBALL_CHROME;
  const candidates = process.platform === "win32"
    ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
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
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=426x240:r=12:d=16,noise=alls=40:allf=t+u",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-crf", "18",
    "-an", "-movflags", "+faststart",
    dest,
  ]);
  const size = fs.statSync(dest).size;
  if (size < 4 * 1024 * 1024) throw new Error(`clip ${dest} is ${size} bytes, need more than 4 MB`);
}

function killChild(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    return;
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

async function runBlobSoak() {
  const durationMs = Number(process.env.PINBALL_BLOB_SOAK_MS || 21 * 60 * 1000);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-blob-"));
  const media = path.join(dir, "media");
  const library = path.join(media, "library");
  await fsp.mkdir(library, { recursive: true });
  const items = [];
  for (let i = 0; i < 3; i += 1) {
    const id = crypto.randomUUID();
    const file = path.join(library, `${id}.mp4`);
    note(`encoding clip ${i + 1}`);
    await makeClip(file);
    items.push({
      id,
      title: `Clip ${i + 1}`,
      file: `${id}.mp4`,
      folder: "library",
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
  const browserPath = chromePath();
  if (!browserPath) throw new Error("Google Chrome was not found");
  const profile = path.join(dir, "chrome-profile");
  const debugPort = 9342;
  const children = [];
  let browser = null;
  try {
    const pin = { "x-pin": "2224", "content-type": "application/json" };
    const rotated = await fetch(`${healthOrigin}/api/rotation`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({
        enabled: true,
        intervalSec: 120,
        items: {
          logoPinnacle: false,
          logoEntertainment: false,
          amenities: false,
          clock: false,
          pinboard: false,
        },
      }),
    });
    if (!rotated.ok) throw new Error(`rotation ${rotated.status}`);
    const positions = [[0, 0], [80, 60], [160, 120]];
    const slots = [1, 2, 3];
    note(`chrome ${browserPath}`);
    const first = spawn(browserPath, [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      `--app=${origins[1]}/display/1`,
      `--window-position=${positions[0][0]},${positions[0][1]}`,
      "--window-size=1100,700",
      ...FLAGS,
    ], { stdio: "ignore" });
    children.push(first);
    await waitFor(`http://127.0.0.1:${debugPort}/json/version`);
    for (const slot of [2, 3]) {
      const [x, y] = positions[slot - 1];
      children.push(spawn(browserPath, [
        `--user-data-dir=${profile}`,
        `--app=${origins[slot]}/display/${slot}`,
        `--window-position=${x},${y}`,
        "--window-size=1100,700",
        ...FLAGS,
      ], { stdio: "ignore" }));
    }
    await sleep(1500);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const bySlot = {};
    for (const slot of slots) {
      let page = null;
      for (let attempt = 0; attempt < 20 && !page; attempt += 1) {
        page = browser.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes(`/display/${slot}`));
        if (!page) await sleep(250);
      }
      if (!page) {
        const open = browser.contexts().flatMap((context) => context.pages()).map((item) => item.url()).join(" ");
        throw new Error(`display ${slot} did not open. pages=${open}`);
      }
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
    while (Date.now() - started < durationMs) {
      for (const slot of slots) {
        const sample = await bySlot[slot].evaluate(() => {
          const video = document.getElementById("wall-video");
          return {
            time: Number(video?.currentTime) || 0,
            ready: Number(video?.readyState) || 0,
            paused: Boolean(video?.paused),
            mode: document.getElementById("screen")?.dataset?.mode || "",
            src: video?.currentSrc || "",
            media: video?.dataset?.mediaUrl || "",
          };
        });
        const track = tracks[slot];
        const grace = Date.now() - started < 45000 || Date.now() < (track.graceUntil || 0);
        if (sample.mode === "video" && sample.src.startsWith("blob:") && sample.time > (track.last || 0) + 0.3) {
          track.moved = Date.now();
        }
        if (track.last != null && sample.time + 0.5 < track.last) track.moved = Date.now();
        track.last = sample.time;
        track.src = sample.src;
        if (!grace && !sample.src.startsWith("blob:")) {
          throw new Error(`display ${slot} is not playing a blob (${sample.src.slice(0, 80)})`);
        }
        if (!grace && Date.now() - track.moved > 25000) {
          throw new Error(`display ${slot} stopped advancing at ${sample.time.toFixed(2)} ready=${sample.ready} paused=${sample.paused} mode=${sample.mode}`);
        }
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (elapsed % 60 < 3) {
        note(`t=${elapsed}s times=${slots.map((slot) => tracks[slot].last?.toFixed(1)).join(",")} blobs=${slots.map((slot) => (tracks[slot].src || "").startsWith("blob:") ? "yes" : "no").join(",")}`);
      }
      await sleep(2000);
    }
    const logPath = path.join(dir, "logs", "video.log");
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const wanted = log.split("\n").filter((line) => /event=(blob-loaded|play-start|progress)/.test(line));
    note("--- video.log excerpt ---");
    for (const line of wanted.slice(0, 12)) note(line);
    if (wanted.length > 12) note(`... ${wanted.length - 12} more blob-loaded/play-start/progress lines`);
    if (!wanted.some((line) => line.includes("event=blob-loaded"))) throw new Error("video.log has no blob-loaded");
    if (!wanted.some((line) => line.includes("event=play-start"))) throw new Error("video.log has no play-start");
    if (durationMs >= 70000 && !wanted.some((line) => line.includes("event=progress"))) {
      throw new Error("video.log has no progress heartbeat");
    }
    note(`done ms=${durationMs} lines=${wanted.length}`);
    return { ms: durationMs, lines: wanted.length };
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of children) killChild(child);
    await Promise.all(bound.servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

module.exports = { runBlobSoak };

if (require.main === module) {
  runBlobSoak().then((result) => {
    console.log(JSON.stringify(result));
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
