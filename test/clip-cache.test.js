const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");
const {
  createClipCache,
  moovBeforeMdat,
  probeFile,
  ffmpegBinary,
} = require("../src/clip-cache");

function run(bin, args) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.split("\n").filter(Boolean).slice(-4).join(" ") || `ffmpeg ${code}`));
      else resolve();
    });
  });
}

async function makeClip(dest, { codec = "libx264", faststart = false } = {}) {
  const args = [
    "-y",
    "-hide_banner",
    "-f", "lavfi",
    "-i", "testsrc=size=320x240:rate=12:duration=1",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=44100:duration=1",
    "-c:v", codec,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
  ];
  if (faststart) args.push("-movflags", "+faststart");
  args.push(dest);
  await run(ffmpegBinary(), args);
}

test("a moov-at-end h264 clip is remuxed to faststart and a non-h264 clip is transcoded", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-cache-"));
  const late = path.join(dir, "late.mp4");
  const mpeg = path.join(dir, "mpeg.mp4");
  await makeClip(late, { codec: "libx264", faststart: false });
  await makeClip(mpeg, { codec: "mpeg4", faststart: false });
  assert.equal(await moovBeforeMdat(late), false);
  const cacheDir = path.join(dir, "cache");
  const files = new Map([
    ["http://clips.test/late.mp4", late],
    ["http://clips.test/mpeg.mp4", mpeg],
  ]);
  const cache = createClipCache({
    items: [
      { id: "late-moov", title: "Late", holiday: "halloween", streamUrl: "http://clips.test/late.mp4" },
      { id: "mpeg-clip", title: "Mpeg", holiday: "halloween", streamUrl: "http://clips.test/mpeg.mp4" },
    ],
    cacheDir,
    logFile: path.join(dir, "logs", "video.log"),
    fetchImpl: async (url) => {
      const data = await fsp.readFile(files.get(url));
      return new Response(data, { status: 200 });
    },
  });
  const rows = await cache.runOnce();
  assert.deepEqual(rows.map((row) => row.ready), [true, true]);
  for (const id of ["late-moov", "mpeg-clip"]) {
    const file = cache.readyPath(id);
    assert.equal(await moovBeforeMdat(file), true);
    const info = await probeFile(ffmpegBinary(), file);
    assert.equal(info.videoCodec, "h264");
    assert.equal(info.playable, true);
    assert.equal(cache.fileFor(id), file);
  }
  const log = await fsp.readFile(path.join(dir, "logs", "video.log"), "utf8");
  assert.match(log, /cache ready late-moov/);
  assert.match(log, /cache ready mpeg-clip/);
});

test("a stall timeout pauses a cached clip and a pinned screen stays on video", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-fail-"));
  const media = path.join(dir, "media");
  const id = crypto.randomUUID();
  const other = crypto.randomUUID();
  await fsp.mkdir(path.join(media, "library"), { recursive: true });
  await fsp.writeFile(path.join(media, "library", "clip.mp4"), Buffer.from("mp4"));
  await fsp.writeFile(path.join(media, "library", "other.mp4"), Buffer.from("mp4"));
  await fsp.writeFile(path.join(media, "library.json"), JSON.stringify({
    items: [{
      id,
      title: "Lobby loop",
      file: "clip.mp4",
      folder: "library",
      tags: [],
      allAges: true,
      inRotation: true,
      loop: true,
      bytes: 3,
      addedAt: 1,
    }, {
      id: other,
      title: "Second loop",
      file: "other.mp4",
      folder: "library",
      tags: [],
      allAges: true,
      inRotation: true,
      loop: true,
      bytes: 3,
      addedAt: 2,
    }],
  }));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  let nowMs = 1_700_000_000_000;
  const { app } = createApp({
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
    clock: () => nowMs,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const pin = { "x-pin": "2224", "content-type": "application/json" };
    const pinned = await fetch(`${origin}/api/displays`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({ screens: { 1: { content: "video" }, 2: { content: "rotation" }, 3: { content: "rotation" } } }),
    });
    assert.equal(pinned.status, 200);
    const before = await (await fetch(`${origin}/api/state`)).json();
    const firstId = before.rotationPlan["1"].id;
    assert.ok([id, other].includes(firstId));
    const stalled = await fetch(`${origin}/api/media/failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "stalled",
        slot: "1",
        id: firstId,
        title: "Lobby loop",
        code: 4,
        networkState: 2,
        readyState: 1,
        currentTime: 0,
        src: `/media/videos/${id}`,
      }),
    });
    assert.equal(stalled.status, 200);
    const suspended = await fetch(`${origin}/api/media/failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "suspend",
        slot: "1",
        id: firstId,
        title: "Lobby loop",
        networkState: 1,
        readyState: 1,
        currentTime: 3.3,
        src: `/media/videos/${firstId}`,
      }),
    });
    assert.equal(suspended.status, 200);
    const still = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(still.rotationPlan["1"].id, firstId);
    assert.notEqual(still.playlist.find((card) => card.id === firstId).blocked, true);
    const ended = await fetch(`${origin}/api/media/failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ended", slot: "1", id: firstId, title: "Lobby loop", currentTime: 12, src: `/media/videos/${firstId}` }),
    });
    assert.equal(ended.status, 200);
    const advanced = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(advanced.rotationPlan["1"].type, "video");
    assert.notEqual(advanced.rotationPlan["1"].id, firstId);
    const secondId = advanced.rotationPlan["1"].id;
    const beforeTimeout = ["2", "3"].map((slot) => advanced.rotationPlan[slot] && `${advanced.rotationPlan[slot].type}:${advanced.rotationPlan[slot].id || advanced.rotationPlan[slot].key || ""}`);
    const timeout = await fetch(`${origin}/api/media/failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "stall-timeout", slot: "1", id: secondId, title: "Second loop", code: null, networkState: 2, readyState: 2, currentTime: 3.4, src: `/media/videos/${secondId}` }),
    });
    assert.equal(timeout.status, 200);
    const after = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(after.rotationPlan["1"].id, secondId);
    assert.notEqual(after.playlist.find((card) => card.id === secondId).blocked, true);
    const afterOthers = ["2", "3"].map((slot) => after.rotationPlan[slot] && `${after.rotationPlan[slot].type}:${after.rotationPlan[slot].id || after.rotationPlan[slot].key || ""}`);
    assert.deepEqual(afterOthers, beforeTimeout);
    const giveUp = await fetch(`${origin}/api/media/failure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "give-up", slot: "1", id: secondId, failedIds: [firstId, secondId], title: "Second loop", currentTime: 0, src: "" }),
    });
    assert.equal(giveUp.status, 200);
    const replaced = await (await fetch(`${origin}/api/state`)).json();
    const keys = ["1", "2", "3"].map((slot) => {
      const card = replaced.rotationPlan[slot];
      if (!card) return "";
      if (card.type === "video") return `video:${card.id}`;
      if (card.type === "logo") return `logo:${card.key}`;
      return card.type;
    });
    assert.equal(new Set(keys).size, 3, JSON.stringify(keys));
    assert.notEqual(replaced.rotationPlan["1"].type, "video");
    assert.equal(fs.existsSync(path.join(media, "library", "clip.mp4")), true);
    const log = fs.readFileSync(path.join(dir, "logs", "video.log"), "utf8");
    assert.match(log, new RegExp(`event=stalled id=${firstId}`));
    assert.match(log, /networkState=2/);
    assert.match(log, /readyState=1/);
    assert.match(log, /event=stall-timeout/);
    assert.doesNotMatch(log, /blockedUntil=/);
    assert.match(log, /event=ended/);
    assert.match(log, /event=suspend/);
  } finally {
    server.close();
  }
});

test("a blocklisted starter is deleted from the cache and never downloaded", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-santa-"));
  const cacheDir = path.join(dir, "cache");
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(path.join(cacheDir, "santas-surprise-1947.mp4"), "remove me");
  let fetched = 0;
  const cache = createClipCache({
    items: [{
      id: "santas-surprise-1947",
      title: "Santa's Surprise",
      holiday: "christmas",
      streamUrl: "http://clips.test/santa.mp4",
      color: true,
    }],
    cacheDir,
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("should not download");
    },
  });
  const rows = await cache.runOnce();
  assert.deepEqual(rows, []);
  assert.equal(fetched, 0);
  assert.equal(fs.existsSync(path.join(cacheDir, "santas-surprise-1947.mp4")), false);
});
