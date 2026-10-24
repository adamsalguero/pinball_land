const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { Store } = require("../src/store");
const { createApp } = require("../src/app");
const { buildPlaylist, normalizeRotation, planRotation, rotationKey } = require("../src/playlist");
const { applyClipHandoff, noteClipRelease, noteClipIdle, slotMayPlay, clipsToRelease } = require("../public/rotation");

const SKELETON = "/media/cache/skeleton-dance-1929";
const CHRISTMAS = "/media/cache/christmas-comes-1936";
const layout = {
  1: { content: "rotation", enabled: true },
  2: { content: "rotation", enabled: true },
  3: { content: "rotation", enabled: true },
};

function wallPlaylist() {
  return buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] }, {
    pinboard: false,
    starters: [
      { type: "video", id: "starter:skeleton-dance-1929", url: SKELETON, durationSec: 331, holiday: "halloween" },
      { type: "video", id: "starter:christmas-comes-1936", url: CHRISTMAS, durationSec: 498, holiday: "christmas" },
    ],
  });
}

function serve(playlist, now, handoff, intervalSec = 30) {
  const desired = planRotation(playlist, {
    startedAt: 0,
    intervalSec,
    screenCount: 3,
    layout,
    now,
  });
  const next = planRotation(playlist, {
    startedAt: 0,
    intervalSec,
    screenCount: 3,
    layout,
    now: now + intervalSec * 1000,
  });
  return { desired, next, ...applyClipHandoff(desired, next, handoff, playlist) };
}

function videoUrls(plan) {
  return ["1", "2", "3"].map((slot) => (plan?.[slot]?.type === "video" && plan[slot].url ? plan[slot].url : "")).filter(Boolean);
}

function keysOf(plan) {
  return ["1", "2", "3"].map((slot) => rotationKey(plan?.[slot]));
}

function assertExclusive(served, label) {
  for (const [name, plan] of [["current", served.plan], ["next", served.nextPlan]]) {
    const urls = videoUrls(plan);
    assert.equal(new Set(urls).size, urls.length, `${label} ${name} urls ${urls.join(" ")}`);
    const keys = keysOf(plan);
    assert.equal(new Set(keys).size, keys.length, `${label} ${name} cards ${keys.join(" ")}`);
    assert.equal(keys.filter(Boolean).length, 3, `${label} ${name} empty card ${keys.join(" ")}`);
  }
}

function players(plan, nextPlan, url) {
  return ["1", "2", "3"].filter((slot) => videoUrl(plan?.[slot]) === url && slotMayPlay(plan, nextPlan, slot, url));
}

function videoUrl(card) {
  return card?.type === "video" && card.url && !card.empty ? card.url : "";
}

function overlaps(before, after, url) {
  const stale = new Set(players(before.plan, before.nextPlan, url));
  const fresh = new Set(players(after.plan, after.nextPlan, url));
  for (const left of stale) {
    for (const right of fresh) {
      if (left !== right) return true;
    }
  }
  return false;
}

test("christmas cannot show on two screens while it walks from screen 1 to screen 2", () => {
  const playlist = wallPlaylist();
  const interval = 30;
  let handoff = { granted: {}, released: {} };
  const at = (tick) => {
    const served = serve(playlist, tick * interval * 1000, handoff, interval);
    handoff = served.handoff;
    return served;
  };

  const showing = at(3);
  assert.deepEqual(videoUrls(showing.plan), [CHRISTMAS]);
  assert.equal(showing.plan["1"].url, CHRISTMAS);
  assert.deepEqual(players(showing.plan, showing.nextPlan, CHRISTMAS), ["1"]);
  assert.equal(overlaps(showing, showing, CHRISTMAS), false);
  const owned = JSON.stringify(showing.desired);

  const held = at(4);
  assert.equal(JSON.stringify(held.desired), JSON.stringify(planRotation(playlist, {
    startedAt: 0,
    intervalSec: interval,
    screenCount: 3,
    layout,
    now: 4 * interval * 1000,
  })));
  assert.notEqual(JSON.stringify(held.desired), owned);
  assert.deepEqual(videoUrls(held.plan), []);
  assert.deepEqual(videoUrls(held.nextPlan).filter((url) => url === CHRISTMAS), []);
  assertExclusive(held, "withheld");
  assert.deepEqual(players(held.plan, held.nextPlan, CHRISTMAS), []);
  assert.equal(overlaps(showing, held, CHRISTMAS), false);
  assert.deepEqual(clipsToRelease(showing.plan, held.plan, "1", CHRISTMAS), [CHRISTMAS]);
  assert.deepEqual(clipsToRelease(showing.plan, held.plan, "2", ""), []);

  const wrong = noteClipRelease(handoff, CHRISTMAS, "2");
  assert.equal(wrong.changed, false);
  const still = serve(playlist, 4 * interval * 1000, wrong, interval);
  assert.deepEqual(videoUrls(still.plan), []);

  const idleOther = noteClipIdle(handoff, "3");
  assert.equal(idleOther.changed, false);

  const halfway = serve(playlist, 4 * interval * 1000 + 15000, handoff, interval);
  assert.deepEqual(videoUrls(halfway.plan), []);
  assertExclusive(halfway, "halfway");
  assert.notDeepEqual(keysOf(halfway.plan), keysOf(held.plan));

  const released = noteClipRelease(handoff, CHRISTMAS, "1");
  assert.equal(released.changed, true);
  const granted = serve(playlist, 4 * interval * 1000 + 15000, released, interval);
  assert.deepEqual(videoUrls(granted.plan), [CHRISTMAS]);
  assert.equal(granted.plan["2"].url, CHRISTMAS);
  assert.equal(granted.plan["2"].playId, held.desired["2"].playId);
  assertExclusive(granted, "granted");
  assert.deepEqual(players(granted.plan, granted.nextPlan, CHRISTMAS), ["2"]);
  assert.equal(overlaps(held, granted, CHRISTMAS), false);
  assert.deepEqual(clipsToRelease(held.plan, granted.plan, "1", ""), []);
  assert.deepEqual(clipsToRelease(held.plan, granted.plan, "2", ""), []);
  assert.equal(slotMayPlay(granted.plan, granted.nextPlan, "3", CHRISTMAS), false);
});

test("a new holiday file can start while the previous file is still unreleased", () => {
  const playlist = wallPlaylist();
  let handoff = { granted: {}, released: {} };
  const onSkeleton = serve(playlist, 0, handoff);
  handoff = onSkeleton.handoff;
  assert.equal(onSkeleton.plan["1"].url, SKELETON);
  const christmas = serve(playlist, 3 * 30000, handoff);
  assert.deepEqual(videoUrls(christmas.plan), [CHRISTMAS]);
  assert.equal(christmas.plan["1"].url, CHRISTMAS);
  assert.equal(christmas.handoff.granted[SKELETON], "1");
  assert.deepEqual(videoUrls(christmas.plan).filter((url) => url === SKELETON), []);
  assert.equal(overlaps(onSkeleton, christmas, SKELETON), false);
  assert.equal(overlaps(onSkeleton, christmas, CHRISTMAS), false);
  assertExclusive(christmas, "cutover");
});

test("the same screen keeps a clip until the dwell actually moves it", () => {
  const playlist = wallPlaylist();
  const first = serve(playlist, 3 * 30000, { granted: {}, released: {} });
  const later = serve(playlist, 3 * 30000 + 10000, first.handoff);
  assert.equal(later.plan["1"].url, CHRISTMAS);
  assert.equal(later.plan["1"].playId, first.plan["1"].playId);
  assert.deepEqual(clipsToRelease(first.plan, later.plan, "1", CHRISTMAS), []);
  const duplicate = {
    1: { type: "video", url: CHRISTMAS, id: "starter:christmas-comes-1936" },
    2: { type: "video", url: CHRISTMAS, id: "starter:christmas-comes-1936" },
    3: { type: "clock", id: "clock" },
  };
  assert.equal(slotMayPlay(duplicate, {}, "1", CHRISTMAS), true);
  assert.equal(slotMayPlay(duplicate, {}, "2", CHRISTMAS), false);
  assert.equal(slotMayPlay({ 1: { type: "logo", key: "pinnacle" } }, { 2: { type: "video", url: CHRISTMAS, id: "x" } }, "2", CHRISTMAS), false);
});

test("the running server holds christmas back until screen 1 releases it", async () => {
  const previousThemes = process.env.PINBALL_STARTER_THEMES;
  process.env.PINBALL_STARTER_THEMES = "halloween,christmas";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-handoff-"));
  const store = await Store.load(path.join(dir, "state.json"));
  const root = path.join(__dirname, "..");
  let nowMs = Date.now();
  const { app, attachWebSocket } = createApp({
    store,
    pin: "2224",
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    cacheDir: path.join(dir, "opdb"),
    dataDir: dir,
    catalogPath: path.join(root, "media", "catalog.json"),
    clock: () => nowMs,
    readyClipIds: ["skeleton-dance-1929", "christmas-comes-1936"],
    publicProbe: async () => ({ url: "", source: "" }),
  });
  const server = http.createServer(app);
  attachWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const pin = { "content-type": "application/json", "x-pin": "2224" };
    const rotated = await fetch(`${origin}/api/rotation`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({
        enabled: true,
        intervalSec: 10,
        items: {
          logoPinnacle: true,
          logoEntertainment: true,
          amenities: true,
          clock: true,
          pinboard: false,
        },
      }),
    });
    assert.equal(rotated.status, 200);
    const startedAt = (await rotated.json()).state.rotation.startedAt;
    nowMs = startedAt;
    const themed = await fetch(`${origin}/api/theme`, {
      method: "PUT",
      headers: pin,
      body: JSON.stringify({ theme: "halloween" }),
    });
    assert.equal(themed.status, 200);
    const read = async () => (await fetch(`${origin}/api/state`)).json();
    nowMs = startedAt + 30000;
    const onScreen = await read();
    assert.equal(onScreen.rotationPlan["1"]?.url, CHRISTMAS, JSON.stringify(videoUrls(onScreen.rotationPlan)));
    assert.equal(videoUrls(onScreen.rotationPlan).length, 1);
    assert.equal(new Set(keysOf(onScreen.rotationPlan)).size, 3, keysOf(onScreen.rotationPlan).join(" "));
    nowMs = startedAt + 40000;
    const held = await read();
    assert.deepEqual(videoUrls(held.rotationPlan), []);
    assert.deepEqual(videoUrls(held.nextRotationPlan).filter((url) => url === CHRISTMAS), []);
    assert.equal(new Set(keysOf(held.rotationPlan)).size, 3, keysOf(held.rotationPlan).join(" "));
    assert.equal(new Set(keysOf(held.nextRotationPlan)).size, 3, keysOf(held.nextRotationPlan).join(" "));
    socket.send(JSON.stringify({ type: "clip-release", url: CHRISTMAS, slot: "2" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ignored = await read();
    assert.deepEqual(videoUrls(ignored.rotationPlan), []);
    const grantedMessage = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("screen 1 release did not hand christmas to one screen")), 2000);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.type !== "state") return;
        if (videoUrls(message.rotationPlan).length !== 1) return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    socket.send(JSON.stringify({ type: "clip-release", url: CHRISTMAS, slot: "1" }));
    const granted = await grantedMessage;
    assert.equal(granted.rotationPlan["2"].url, CHRISTMAS);
    assert.equal(videoUrls(granted.rotationPlan).length, 1);
    assert.ok(granted.rotationPlan["2"].playId);
    assert.equal(new Set(keysOf(granted.rotationPlan)).size, 3, keysOf(granted.rotationPlan).join(" "));
    const again = await read();
    assert.equal(again.rotationPlan["2"].url, CHRISTMAS);
    assert.equal(videoUrls(again.rotationPlan).length, 1);
  } finally {
    if (previousThemes === undefined) delete process.env.PINBALL_STARTER_THEMES;
    else process.env.PINBALL_STARTER_THEMES = previousThemes;
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
