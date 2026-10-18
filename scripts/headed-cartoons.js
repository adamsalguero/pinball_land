const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");
const { createApp } = require("../src/app");
const { Store } = require("../src/store");

const CLIP_DIR = process.env.PINBALL_CLIP_DIR || "/tmp/pinball-cartoons";
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
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function note(line) {
  fs.appendFileSync("/tmp/headed-cartoons.log", `${new Date().toISOString()} ${line}\n`);
}

async function waitFor(url, attempts = 50) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 400) return;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw last || new Error(`timed out waiting for ${url}`);
}

async function shotAdmin(origin) {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${origin}/admin`);
    await page.fill("#pin-input", "2224");
    await page.click("#login-form button");
    await page.waitForSelector("[data-tab='leaderboards']");
    await page.click("[data-tab='leaderboards']");
    await page.waitForSelector("text=Show photo on wall");
    await page.waitForSelector("text=Approve, keep photo private (verification only)");
    const file = "/opt/cursor/artifacts/admin-score-photo-controls.png";
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } finally {
    await browser.close();
  }
}

async function runHeadedCartoons() {
  const files = fs.readdirSync(CLIP_DIR).filter((name) => name.endsWith(".mp4")).sort();
  if (files.length < 5) throw new Error(`need 5 cartoons in ${CLIP_DIR}, found ${files.length}`);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-headed-"));
  const media = path.join(dir, "media");
  const library = path.join(media, "library");
  await fsp.mkdir(library, { recursive: true });
  const items = files.map((name) => {
    const id = crypto.randomUUID();
    fs.symlinkSync(path.join(CLIP_DIR, name), path.join(library, `${id}.mp4`));
    return {
      id,
      title: name.replace(/\.mp4$/, ""),
      file: `${id}.mp4`,
      folder: "library",
      tags: [],
      allAges: true,
      inRotation: true,
      loop: false,
      bytes: fs.statSync(path.join(CLIP_DIR, name)).size,
      addedAt: Date.now(),
    };
  });
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
  const server = http.createServer(app);
  attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pin = { "x-pin": "2224", "content-type": "application/json" };
  const chrome = [];
  const browsers = [];
  try {
    const board = await fetch(`${origin}/api/machines`, {
      method: "POST",
      headers: pin,
      body: JSON.stringify({ name: "Medieval Madness", opdbId: "GTEST-HEADED" }),
    });
    const made = await board.json();
    if (!board.ok || !made.state?.leaderboards?.length) {
      throw new Error(`machine ${board.status} ${JSON.stringify(made)}`);
    }
    const boardId = made.state.leaderboards.at(-1).id;
    const sharp = require("sharp");
    const jpeg = await sharp({
      create: { width: 240, height: 160, channels: 3, background: { r: 180, g: 40, b: 40 } },
    }).jpeg().toBuffer();
    const proofDir = path.join(dir, "score-proofs");
    await fsp.mkdir(proofDir, { recursive: true });
    const proof = `${crypto.randomUUID()}.jpg`;
    await fsp.writeFile(path.join(proofDir, proof), jpeg);
    const submitted = await store.submitScore({
      boardId,
      name: "Ada Lovelace",
      score: 125000,
      proofFile: proof,
      ip: "127.0.0.1",
      now: Date.now(),
    });
    await store.reviewScore(submitted.id, "approved", { showPhoto: true });
    const pendingProof = `${crypto.randomUUID()}.jpg`;
    await fsp.writeFile(path.join(proofDir, pendingProof), jpeg);
    await store.submitScore({
      boardId,
      name: "Grace Hopper",
      score: 88000,
      proofFile: pendingProof,
      ip: "127.0.0.2",
      now: Date.now(),
    });
    note("admin screenshot");
    await shotAdmin(origin);
    note("admin screenshot saved");

    const pinned = await fetch(`${origin}/api/displays`, {
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
    const positions = [[0, 0], [420, 180], [780, 360]];
    for (let index = 0; index < 3; index += 1) {
      const slot = index + 1;
      const port = 9340 + slot;
      const profile = path.join(dir, `chrome-${slot}`);
      const [x, y] = positions[index];
      const child = spawn("/usr/bin/google-chrome", [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        `--app=${origin}/display/${slot}`,
        `--window-position=${x},${y}`,
        "--window-size=1000,720",
        "--no-sandbox",
        "--force-device-scale-factor=1",
        ...FLAGS,
      ], {
        stdio: ["ignore", "ignore", fs.openSync(path.join(dir, `chrome-${slot}.log`), "a")],
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":1" },
      });
      chrome.push(child);
      await waitFor(`http://127.0.0.1:${port}/json/version`);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      browsers.push(browser);
    }
    const covered = [new Map(), new Map(), new Map()];
    const quietSince = [0, 0, 0];
    let grabbed = false;
    const titles = new Map(items.map((item) => [item.id, item.title]));
    const started = new Map();
    const deadline = Date.now() + 15 * 60 * 1000;
    const finished = (map) => map.size >= items.length && [...map.values()].every((sec) => sec >= 60);
    while (covered.some((map) => !finished(map))) {
      if (Date.now() > deadline) {
        const summary = covered.map((map) => [...map.entries()].map(([id, sec]) => `${titles.get(id)}:${sec.toFixed(1)}`).join(", "));
        throw new Error(`clips did not all pass 60s: ${summary.join(" | ")}`);
      }
      for (let index = 0; index < browsers.length; index += 1) {
        const pages = browsers[index].contexts()[0].pages();
        const page = pages.find((item) => item.url().includes(`/display/${index + 1}`)) || pages[0];
        if (!page) {
          if (!quietSince[index]) quietSince[index] = Date.now();
          if (Date.now() - quietSince[index] > 45000) throw new Error(`display ${index + 1} has no page`);
          continue;
        }
        const sample = await page.evaluate(() => {
          const video = document.getElementById("wall-video");
          return {
            src: video?.currentSrc || video?.getAttribute("src") || "",
            time: Number(video?.currentTime) || 0,
            paused: Boolean(video?.paused),
            ready: Number(video?.readyState) || 0,
            connected: Boolean(video?.isConnected),
            mode: document.getElementById("screen")?.dataset?.mode || "",
            vis: document.visibilityState,
            quiet: document.getElementById("screen")?.dataset?.quiet || "",
            stall: document.getElementById("screen")?.dataset?.stall || "",
            seeking: Boolean(video?.seeking),
            rate: video?.playbackRate,
          };
        });
        if (!sample.connected || sample.mode !== "video" || !sample.src || sample.ready < 3 || sample.time < 1) {
          if (!quietSince[index]) quietSince[index] = Date.now();
          if (Date.now() - quietSince[index] > 70000) {
            throw new Error(`display ${index + 1} never started (${sample.mode}, connected=${sample.connected}, ready=${sample.ready}, t=${sample.time})`);
          }
          continue;
        }
        quietSince[index] = 0;
        const id = items.find((item) => sample.src.includes(item.id))?.id;
        if (!id) continue;
        const key = `${index}:${id}`;
        const mark = started.get(key);
        const already = (covered[index].get(id) || 0) >= 60;
        if (!mark || sample.time + 5 < mark.last) {
          started.set(key, { last: sample.time, at: Date.now(), moved: Date.now(), gained: covered[index].get(id) || 0, advanced: already });
          if (already) {
            const ended = await fetch(`${origin}/api/media/failure`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ event: "ended", slot: String(index + 1), id, currentTime: sample.time, src: sample.src }),
            });
            if (!ended.ok) throw new Error(`ended ${ended.status}`);
          }
          continue;
        }
        const step = sample.time - mark.last;
        if (step >= 1) {
          if (mark.gained < 60) mark.moved = Date.now();
          if (step < 15) mark.gained += step;
          mark.last = sample.time;
          covered[index].set(id, mark.gained);
        }
        if (mark.gained >= 60) {
          covered[index].set(id, mark.gained);
          const needsMore = items.some((item) => (covered[index].get(item.id) || 0) < 60);
          if (!mark.advanced || Date.now() - mark.moved > (needsMore ? 2000 : 15000)) {
            mark.advanced = true;
            mark.moved = Date.now();
            const ended = await fetch(`${origin}/api/media/failure`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ event: "ended", slot: String(index + 1), id, currentTime: sample.time, src: sample.src }),
            });
            if (!ended.ok) throw new Error(`ended ${ended.status}`);
          }
          continue;
        }
        if (Date.now() - mark.moved > 40000) {
          throw new Error(`display ${index + 1} stalled on ${titles.get(id)} at ${sample.time.toFixed(2)} ready=${sample.ready} paused=${sample.paused} vis=${sample.vis} seeking=${sample.seeking} rate=${sample.rate} quiet=${sample.quiet} stall=${sample.stall} gained=${mark.gained.toFixed(1)}`);
        }
      }
      const line = covered.map((map, index) => {
        const min = map.size ? Math.min(...map.values()) : 0;
        return `s${index + 1} ${map.size}/${items.length} min=${min.toFixed(0)}`;
      }).join(" ");
      note(line);
      if (!grabbed && [...started.values()].length >= 3) {
        grabbed = true;
        await sleep(8000);
        await new Promise((resolve) => {
          const grab = spawn("ffmpeg", [
            "-y", "-f", "x11grab", "-video_size", "1920x1200", "-i", process.env.DISPLAY || ":1",
            "-frames:v", "1", "/opt/cursor/artifacts/cartoons-three-windows.png",
          ], { stdio: "ignore" });
          grab.on("close", () => resolve());
          grab.on("error", () => resolve());
        });
      }
      await sleep(2000);
    }
    for (let index = 0; index < browsers.length; index += 1) {
      const pages = browsers[index].contexts()[0].pages();
      const page = pages.find((item) => item.url().includes(`/display/${index + 1}`)) || pages[0];
      if (page) await page.screenshot({ path: `/opt/cursor/artifacts/cartoon-display-${index + 1}.png` });
    }
    for (let index = 0; index < browsers.length; index += 1) {
      for (const item of items) {
        const gained = covered[index].get(item.id) || 0;
        if (gained < 60) throw new Error(`${item.title} on display ${index + 1} only advanced ${gained.toFixed(1)}s`);
      }
    }
    return covered.map((map) => Object.fromEntries([...map.entries()].map(([id, sec]) => [titles.get(id), Number(sec.toFixed(1))])));
  } finally {
    for (const browser of browsers) await browser.close().catch(() => {});
    for (const child of chrome) child.kill("SIGKILL");
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { runHeadedCartoons, shotAdmin };

if (require.main === module) {
  runHeadedCartoons().then((result) => {
    note(JSON.stringify(result));
    console.log(JSON.stringify(result, null, 2));
  }).catch((err) => {
    note(err && err.stack ? err.stack : String(err));
    console.error(err);
    process.exit(1);
  });
}
