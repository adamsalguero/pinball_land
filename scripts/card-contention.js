const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");
const ffmpegPath = require("ffmpeg-static");
const { createApp } = require("../src/app");
const { Store } = require("../src/store");
const { bindDisplayServers } = require("../src/server");
const { findChrome } = require("../src/wall-chrome");

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
  return text;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.split("\n").filter(Boolean).slice(-8).join(" ") || `${bin} ${code}`));
      else resolve();
    });
  });
}

async function waitFor(url, attempts = 80) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 400) return;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw last || new Error(`timed out waiting for ${url}`);
}

function killChild(child) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

async function makeClip(dest) {
  await run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=20",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.0", "-r", "30", "-g", "60", "-keyint_min", "60",
    "-an", "-movflags", "+faststart",
    "-metadata", "comment=pinball-transcode-v1",
    dest,
  ]);
}

async function runCardContention() {
  const durationMs = Number(process.env.PINBALL_CARD_SOAK_MS || 10 * 60 * 1000);
  const browserPath = findChrome();
  if (!browserPath) throw new Error("Google Chrome was not found");
  if (!process.env.DISPLAY) throw new Error("DISPLAY is required so the three windows are visible");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-cards-"));
  const media = path.join(dir, "media");
  const cacheDir = path.join(media, "cache");
  await fsp.mkdir(cacheDir, { recursive: true });
  await makeClip(path.join(cacheDir, "skeleton-dance-1929.mp4"));
  process.env.PINBALL_CLIP_IDS = "skeleton-dance-1929";
  process.env.PINBALL_STARTER_THEMES = "halloween";
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
    clipCache: true,
    catalogPath: path.join(root, "media", "catalog.json"),
  });
  const bound = await bindDisplayServers(app, { port: 0, attach: attachWebSocket });
  const origins = bound.displayOrigins;
  const children = [];
  const browsers = [];
  try {
    const pin = { "x-pin": "2224", "content-type": "application/json" };
    const theme = await fetch(`${origins[1]}/api/theme`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({ theme: "halloween" }),
    });
    if (!theme.ok) throw new Error(`theme ${theme.status}`);
    await fetch(`${origins[1]}/api/leaderboards`, {
      method: "POST",
      headers: pin,
      body: JSON.stringify({ name: "High scores" }),
    }).catch(() => {});
    await fetch(`${origins[1]}/api/machines`, {
      method: "POST",
      headers: pin,
      body: JSON.stringify({ name: "Medieval Madness" }),
    });
    const displays = await fetch(`${origins[1]}/api/displays`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({
        count: 3,
        screens: {
          1: { content: "rotation", enabled: true },
          2: { content: "rotation", enabled: true },
          3: { content: "rotation", enabled: true },
        },
      }),
    });
    if (!displays.ok) throw new Error(`displays ${displays.status}`);
    const readyDeadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const body = await (await fetch(`${origins[1]}/api/state`)).json();
      ready = (body.playlist || []).some((card) => card.type === "video" && String(card.url || "").includes("skeleton-dance-1929"));
      if (ready) break;
      await sleep(400);
    }
    if (!ready) throw new Error("halloween clip was not ready");
    const positions = [[0, 0], [640, 0], [1280, 0]];
    const ports = { 1: 9352, 2: 9353, 3: 9354 };
    for (const slot of [1, 2, 3]) {
      const [x, y] = positions[slot - 1];
      const child = spawn(browserPath, [
        `--user-data-dir=${path.join(dir, "chrome", `display${slot}`)}`,
        `--remote-debugging-port=${ports[slot]}`,
        `--app=${origins[slot]}/display/${slot}`,
        `--window-position=${x},${y}`,
        "--window-size=620,480",
        ...FLAGS,
      ], { detached: true, stdio: "ignore", env: { ...process.env, DISPLAY: process.env.DISPLAY } });
      child.unref();
      children.push(child);
    }
    const bySlot = {};
    for (const slot of [1, 2, 3]) {
      await waitFor(`http://127.0.0.1:${ports[slot]}/json/version`);
      const connected = await chromium.connectOverCDP(`http://127.0.0.1:${ports[slot]}`);
      browsers.push(connected);
      let page = null;
      for (let attempt = 0; attempt < 30 && !page; attempt += 1) {
        page = connected.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes(`/display/${slot}`));
        if (!page) await sleep(250);
      }
      if (!page) throw new Error(`display ${slot} did not open`);
      bySlot[slot] = page;
    }
    const samples = [];
    const started = Date.now();
    let videoSlot = "";
    let advanced = false;
    while (Date.now() - started < durationMs) {
      const row = {};
      for (const slot of [1, 2, 3]) {
        row[slot] = await bySlot[slot].evaluate(() => {
          const video = document.getElementById("wall-video");
          const quality = video?.getVideoPlaybackQuality?.() || {};
          return {
            mode: document.getElementById("screen")?.dataset?.mode || "",
            videos: document.querySelectorAll("video").length,
            time: Number(video?.currentTime) || 0,
            dropped: Number(quality.droppedVideoFrames) || 0,
            total: Number(quality.totalVideoFrames) || 0,
            media: video?.dataset?.mediaUrl || "",
          };
        });
      }
      samples.push(row);
      const playing = [1, 2, 3].filter((slot) => row[slot].mode === "video");
      const settled = Date.now() - started > 8000;
      for (const slot of [1, 2, 3]) {
        const cardMode = ["logo", "amenity", "clock", "pinboard", "board", "collage"].includes(row[slot].mode);
        if (settled && cardMode && row[slot].videos !== 0) {
          throw new Error(`display ${slot} mode=${row[slot].mode} still has ${row[slot].videos} video element(s)`);
        }
      }
      if (playing.length > 1) {
        const medias = playing.map((slot) => row[slot].media).filter(Boolean);
        if (new Set(medias).size !== medias.length) throw new Error(`duplicate clip ${medias.join(" ")}`);
      }
      if (playing.length === 1) {
        videoSlot = String(playing[0]);
        const previous = samples.length > 2 ? samples[samples.length - 2][playing[0]] : null;
        if (previous && row[playing[0]].time > previous.time + 0.2) advanced = true;
      }
      if (Math.round((Date.now() - started) / 1000) % 30 < 3) {
        note(`t=${Math.round((Date.now() - started) / 1000)}s ${[1, 2, 3].map((slot) => `${slot}:${row[slot].mode}/v${row[slot].videos}/t${row[slot].time.toFixed(1)}/d${row[slot].dropped}/${row[slot].total}`).join(" ")}`);
      }
      await sleep(2000);
    }
    if (!advanced) throw new Error("the video screen did not advance currentTime");
    const logPath = path.join(dir, "logs", "video.log");
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    if (!/videos=\d+/.test(log)) throw new Error("video.log has no video element count");
    if (durationMs >= 20000 && !/event=perf /.test(log)) throw new Error("video.log has no perf line");
    const cardLines = log.split("\n").filter((line) => /event=perf /.test(line) && /card=(logo|amenity|clock|pinboard|leaderboard|board)/.test(line));
    if (durationMs >= 60000 && cardLines.some((line) => /videos=[1-9]/.test(line))) {
      throw new Error(`a card screen reported a video element: ${cardLines.find((line) => /videos=[1-9]/.test(line))}`);
    }
    const summary = {
      ms: durationMs,
      videoSlot,
      advanced,
      last: samples.at(-1),
      perf: (log.match(/event=perf /g) || []).length,
      progress: (log.match(/event=progress /g) || []).length,
    };
    note(`done ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    for (const connected of browsers) await connected.close().catch(() => {});
    for (const child of children) killChild(child);
    await Promise.all(bound.servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

module.exports = { runCardContention };

if (require.main === module) {
  runCardContention().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
