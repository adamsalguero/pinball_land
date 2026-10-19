const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");
const { createApp } = require("../src/app");
const { Store } = require("../src/store");
const { bindDisplayServers } = require("../src/server");
const { loadCatalog } = require("../src/catalog");
const { createClipCache } = require("../src/clip-cache");

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

function killChild(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    if (typeof killer.unref === "function") killer.unref();
  } else {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  if (typeof child.unref === "function") child.unref();
}

async function runBlobSoak() {
  const durationMs = Number(process.env.PINBALL_BLOB_SOAK_MS || 20 * 60 * 1000);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-blob-"));
  const media = path.join(dir, "media");
  const cacheDir = path.join(media, "cache");
  await fsp.mkdir(cacheDir, { recursive: true });
  const catalog = loadCatalog(path.join(__dirname, "..", "media", "catalog.json"))
    .filter((item) => item.id === "skeleton-dance-1929" || item.id === "christmas-comes-1936");
  if (catalog.length !== 2) throw new Error(`expected both starter clips, found ${catalog.map((item) => item.id).join(",")}`);
  note(`transcoding ${catalog.map((item) => item.id).join(" and ")}`);
  const clips = createClipCache({
    items: catalog,
    cacheDir,
    logFile: path.join(dir, "logs", "video.log"),
  });
  const prepared = await clips.runOnce();
  if (prepared.some((row) => !row.ready)) {
    throw new Error(`starter transcode failed: ${JSON.stringify(prepared)}`);
  }
  for (const item of catalog) {
    const size = fs.statSync(clips.readyPath(item.id)).size;
    note(`ready ${item.id} bytes=${size}`);
  }
  process.env.PINBALL_STARTER_THEMES = "halloween,christmas";
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
    catalogPath: path.join(__dirname, "..", "media", "catalog.json"),
  });
  const bound = await bindDisplayServers(app, { port: 0, attach: attachWebSocket });
  const origins = bound.displayOrigins;
  const healthOrigin = origins[2];
  const browserPath = chromePath();
  if (!browserPath) throw new Error("Google Chrome was not found");
  const profile = path.join(dir, "chrome-profile");
  const debugPort = 9342;
  const children = [];
  const browsers = [];
  try {
    const pin = { "x-pin": "2224", "content-type": "application/json" };
    const rotated = await fetch(`${healthOrigin}/api/rotation`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({
        enabled: true,
        intervalSec: 120,
        items: {
          logoPinnacle: true,
          logoEntertainment: true,
          amenities: true,
          clock: true,
          pinboard: false,
        },
      }),
    });
    if (!rotated.ok) throw new Error(`rotation ${rotated.status}`);
    const themed = await fetch(`${healthOrigin}/api/theme`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({ theme: "halloween" }),
    });
    if (!themed.ok) throw new Error(`theme ${themed.status}`);
    let starterUrls = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const body = await (await fetch(`${healthOrigin}/api/state`)).json();
      starterUrls = (body.playlist || []).filter((card) => card.type === "video").map((card) => String(card.url || ""));
      if (starterUrls.some((url) => url.includes("skeleton-dance-1929")) && starterUrls.some((url) => url.includes("christmas-comes-1936"))) break;
      await sleep(250);
    }
    if (!starterUrls.some((url) => url.includes("skeleton-dance-1929")) || !starterUrls.some((url) => url.includes("christmas-comes-1936"))) {
      throw new Error(`starter clips missing from the playlist: ${starterUrls.join(" ")}`);
    }
    const positions = [[0, 0], [80, 60], [160, 120]];
    const slots = [1, 2, 3];
    note(`chrome ${browserPath}`);
    const ports = { 1: debugPort, 2: debugPort + 1, 3: debugPort + 2 };
    const chromeExit = {};
    for (const slot of slots) {
      const [x, y] = positions[slot - 1];
      const child = spawn(browserPath, [
        `--user-data-dir=${path.join(dir, "chrome", `display${slot}`)}`,
        `--remote-debugging-port=${ports[slot]}`,
        `--app=${origins[slot]}/display/${slot}`,
        `--window-position=${x},${y}`,
        "--window-size=1100,700",
        ...FLAGS,
      ], { stdio: "ignore", detached: true });
      child.on("exit", (code) => {
        chromeExit[slot] = code;
      });
      children.push(child);
    }
    const bySlot = {};
    for (const slot of slots) {
      try {
        await waitFor(`http://127.0.0.1:${ports[slot]}/json/version`, 120);
      } catch (err) {
        const gone = Object.prototype.hasOwnProperty.call(chromeExit, slot) ? chromeExit[slot] : "still running";
        throw new Error(`display ${slot} debug port did not open (chrome exit ${gone}): ${err.message}`);
      }
      const connected = await chromium.connectOverCDP(`http://127.0.0.1:${ports[slot]}`);
      browsers.push(connected);
      let page = null;
      for (let attempt = 0; attempt < 20 && !page; attempt += 1) {
        page = connected.contexts().flatMap((context) => context.pages()).find((item) => item.url().includes(`/display/${slot}`));
        if (!page) await sleep(250);
      }
      if (!page) {
        const open = connected.contexts().flatMap((context) => context.pages()).map((item) => item.url()).join(" ");
        throw new Error(`display ${slot} did not open. pages=${open}`);
      }
      bySlot[slot] = page;
    }
    const hosts = new Set(slots.map((slot) => new URL(bySlot[slot].url()).host));
    if (hosts.size !== 3) throw new Error(`expected 3 origins, got ${[...hosts].join(" ")}`);
    const tracks = {
      1: { last: null, moved: Date.now(), media: "", began: 0, checked: false },
      2: { last: null, moved: Date.now(), media: "", began: 0, checked: false },
      3: { last: null, moved: Date.now(), media: "", began: 0, checked: false },
    };
    const seen = new Set();
    const started = Date.now();
    while (Date.now() - started < durationMs) {
      const samples = {};
      for (const slot of slots) {
        samples[slot] = await bySlot[slot].evaluate(() => {
          const video = document.getElementById("wall-video");
          const screen = document.getElementById("screen");
          return {
            time: Number(video?.currentTime) || 0,
            duration: Number(video?.duration) || 0,
            readyState: Number(video?.readyState) || 0,
            armed: video?.dataset?.ready || "",
            paused: Boolean(video?.paused),
            mode: screen?.dataset?.mode || "",
            src: video?.currentSrc || "",
            media: video?.dataset?.mediaUrl || "",
          };
        });
      }
      const playing = slots.map((slot) => (samples[slot].mode === "video" ? samples[slot].media : "")).filter(Boolean);
      if (new Set(playing).size !== playing.length) {
        throw new Error(`two screens loaded the same clip: ${playing.join(" ")}`);
      }
      for (const slot of slots) {
        const sample = samples[slot];
        const track = tracks[slot];
        if (sample.mode !== "video") {
          track.media = "";
          track.checked = false;
          track.last = null;
          track.began = 0;
          continue;
        }
        if (!sample.src.startsWith("blob:")) {
          if (track.began && Date.now() - track.began > 20000) {
            throw new Error(`display ${slot} is not playing a blob (${sample.src.slice(0, 80)})`);
          }
          if (!track.began) track.began = Date.now();
          continue;
        }
        if (track.media !== sample.media) {
          track.media = sample.media;
          track.began = Date.now();
          track.checked = false;
          track.last = sample.time;
          track.moved = Date.now();
        }
        if (!track.checked) {
          if (sample.armed === "1" && sample.duration > 1 && sample.time > 1) {
            const fraction = sample.time / sample.duration;
            if (fraction < 0.4 || fraction > 0.65) {
              throw new Error(`display ${slot} started at ${sample.time.toFixed(2)} of ${sample.duration.toFixed(2)}, outside 40-60%`);
            }
            track.checked = true;
            track.last = sample.time;
            track.moved = Date.now();
            seen.add(sample.media);
          } else if (Date.now() - track.began > 20000) {
            throw new Error(`display ${slot} never reached the 40-60% start (${sample.media})`);
          }
          continue;
        }
        if (sample.time > (track.last || 0) + 0.3) {
          track.last = sample.time;
          track.moved = Date.now();
        }
        if (track.last != null && sample.time + 0.5 < track.last) {
          track.last = sample.time;
          track.moved = Date.now();
        }
        if (Date.now() - track.moved > 5000) {
          throw new Error(`display ${slot} stopped advancing at ${sample.time.toFixed(2)} ready=${sample.readyState} paused=${sample.paused} mode=${sample.mode}`);
        }
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (elapsed % 60 < 3) {
        note(`t=${elapsed}s times=${slots.map((slot) => tracks[slot].last?.toFixed(1)).join(",")} blobs=${slots.map((slot) => (samples[slot].src || "").startsWith("blob:") ? "yes" : "no").join(",")} modes=${slots.map((slot) => samples[slot].mode || "-").join(",")}`);
      }
      await sleep(1000);
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
    if (durationMs >= 10 * 60 * 1000 && seen.size < 2) {
      throw new Error(`both starter clips were not played: ${[...seen].join(" ")}`);
    }
    note(`done ms=${durationMs} lines=${wanted.length} clips=${[...seen].join(" ")}`);
    return { ms: durationMs, lines: wanted.length, clips: [...seen] };
  } finally {
    for (const connected of browsers) await connected.close().catch(() => {});
    for (const child of children) killChild(child);
    await Promise.all(bound.servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

module.exports = { runBlobSoak };

if (require.main === module) {
  runBlobSoak().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
