const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AMENITIES, AMENITY_IDS, getAmenity } = require("../src/amenities");
const {
  buildPlaylist,
  cardForSlot,
  currentTick,
  tickForSlot,
  amenityAt,
  slotIndexForDisplay,
  normalizeRotation,
  planRotation,
  rotationKey,
  videoStartSec,
  replacementFor,
  AMENITY_DWELL_SEC,
} = require("../src/playlist");
const { logoPhaseKey } = require("../public/rotation");

test("amenity cards are arcade, oasis, and events — never pool", () => {
  assert.deepEqual(AMENITY_IDS, ["arcade", "oasis", "events"]);
  assert.equal(getAmenity("oasis").headline, "Outdoor Oasis");
  assert.match(getAmenity("arcade").body, /California/);
  assert.match(getAmenity("events").eventTypes, /Charity Fundraisers/);
  const blob = JSON.stringify(AMENITIES).toLowerCase();
  assert.equal(blob.includes("pool"), false);
  assert.equal(blob.includes("collage"), false);
});

test("rotation defaults on with a 30s interval and one amenities card", () => {
  const rotation = normalizeRotation(undefined);
  assert.equal(rotation.enabled, true);
  assert.equal(rotation.intervalSec, 30);
  assert.equal(rotation.items.logoPinnacle, true);
  assert.equal(rotation.items.amenities, true);
  assert.equal(normalizeRotation({ intervalSec: 14 }).intervalSec, 30);
  assert.equal(normalizeRotation({ intervalSec: 25 }).intervalSec, 30);
  assert.equal(normalizeRotation({ intervalSec: 20 }).intervalSec, 20);
  assert.equal(normalizeRotation({ intervalSec: 8 }).intervalSec, 10);
  assert.equal(normalizeRotation({ intervalSec: 200 }).intervalSec, 120);
  const legacy = normalizeRotation({
    items: { amenityArcade: false, amenityOasis: true, amenityEvents: false },
  });
  assert.equal(legacy.items.amenities, true);
  assert.equal(normalizeRotation({ items: { amenities: false, amenityArcade: true } }).items.amenities, false);
});

test("playlist stagger keeps neighboring TVs on different cards", () => {
  const state = {
    rotation: normalizeRotation({}),
    leaderboards: [
      { id: "evt", inRotation: true },
      { id: "mach", inRotation: true },
    ],
  };
  const playlist = buildPlaylist(state);
  assert.deepEqual(
    playlist.map((card) => card.type + ":" + (card.key || card.id)),
    [
      "logo:pinnacle",
      "logo:pinball-land",
      "amenity:amenities",
      "clock:clock",
      "pinboard:pinboard",
      "leaderboard:evt",
      "leaderboard:mach",
    ]
  );
  assert.equal(playlist.some((card) => card.type === "video"), false);
  assert.ok(playlist.length >= 3);
  for (let tick = 0; tick < playlist.length * 2; tick += 1) {
    const left = cardForSlot(playlist, tick, 0);
    const center = cardForSlot(playlist, tick, 1);
    const right = cardForSlot(playlist, tick, 2);
    assert.notEqual(left, center);
    assert.notEqual(center, right);
  }
  assert.equal(slotIndexForDisplay("1"), 0);
  assert.equal(slotIndexForDisplay("3"), 2);
  const layout = {
    1: { content: "rotation", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "pinboard", enabled: true },
  };
  for (let tick = 0; tick < 12; tick += 1) {
    const plan = planRotation(playlist, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now: tick * 30000,
    });
    const keys = ["1", "2", "3"].map((slot) => rotationKey(plan[slot])).filter(Boolean);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(rotationKey(plan["3"]), "pinboard");
    assert.notEqual(rotationKey(plan["1"]), "pinboard");
    assert.notEqual(rotationKey(plan["2"]), "pinboard");
  }
  const start = videoStartSec("starter:skeleton-dance-1929", 3, 331);
  assert.ok(start >= 331 * 0.4);
  assert.ok(start <= 331 * 0.6);
});

test("currentTick advances by interval and disabled boards drop out", () => {
  const startedAt = 1_000_000;
  assert.equal(currentTick(startedAt, 10, 1_000_000), 0);
  assert.equal(currentTick(startedAt, 10, 1_009_999), 0);
  assert.equal(currentTick(startedAt, 10, 1_010_000), 1);
  const playlist = buildPlaylist({
    rotation: normalizeRotation({
      items: {
        logoPinnacle: false,
        logoEntertainment: true,
        amenities: false,
      },
    }),
    leaderboards: [
      { id: "hidden", inRotation: false },
      { id: "shown", inRotation: true },
    ],
  });
  assert.deepEqual(
    playlist.map((card) => card.type + ":" + (card.key || card.id)),
    ["logo:pinball-land", "clock:clock", "pinboard:pinboard", "leaderboard:shown"]
  );
});

test("screens advance together every dwell and stay on different cards", () => {
  const startedAt = 1_000_000;
  assert.equal(tickForSlot(startedAt, 30, 0, 3, startedAt + 29999), 0);
  assert.equal(tickForSlot(startedAt, 30, 1, 3, startedAt + 29999), 0);
  assert.equal(tickForSlot(startedAt, 30, 2, 3, startedAt + 30000), 1);
  assert.equal(tickForSlot(startedAt, 30, 0, 3, startedAt + 30000), 1);
  const playlist = buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] });
  const layout = {
    1: { content: "rotation", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  const keysOf = (now) => {
    const plan = planRotation(playlist, {
      startedAt,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now,
    });
    return ["1", "2", "3"].map((slot) => rotationKey(plan[slot]));
  };
  const first = keysOf(startedAt + 1000);
  const second = keysOf(startedAt + 31000);
  const third = keysOf(startedAt + 61000);
  for (const keys of [first, second, third]) {
    assert.equal(new Set(keys).size, 3);
  }
  assert.notDeepEqual(first, second);
  assert.notDeepEqual(second, third);
  for (let i = 0; i < 3; i += 1) {
    assert.notEqual(first[i], second[i]);
    assert.notEqual(second[i], third[i]);
  }
  assert.equal(amenityAt(0, 0, 0), "arcade");
  assert.equal(amenityAt(0, 0, AMENITY_DWELL_SEC * 1000), "oasis");
  assert.equal(amenityAt(0, 0, AMENITY_DWELL_SEC * 2000), "events");
  assert.equal(amenityAt(0, 0, AMENITY_DWELL_SEC * 3000), "arcade");
});

test("leaderboard and pinboard subtypes count as one card, and video mode plays a real clip", () => {
  const playlist = [
    { type: "leaderboard", id: "a" },
    { type: "leaderboard", id: "b" },
    { type: "pinboard", id: "pinboard" },
    { type: "collage", id: "collage" },
    { type: "logo", key: "pinnacle" },
    { type: "clock", id: "clock" },
    { type: "video", id: "starter:skeleton-dance-1929", url: "/media/cache/skeleton-dance-1929", durationSec: 331, local: true },
  ];
  assert.equal(rotationKey(playlist[0]), "leaderboard");
  assert.equal(rotationKey(playlist[0]), rotationKey(playlist[1]));
  assert.equal(rotationKey(playlist[2]), "pinboard");
  assert.equal(rotationKey(playlist[2]), rotationKey(playlist[3]));
  const layout = {
    1: { content: "video", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  for (let tick = 0; tick < 12; tick += 1) {
    const plan = planRotation(playlist, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now: tick * 30000,
    });
    const keys = ["1", "2", "3"].map((slot) => rotationKey(plan[slot]));
    assert.equal(new Set(keys).size, 3, JSON.stringify(keys));
    assert.equal(plan["1"].type, "video");
    assert.equal(plan["1"].url, "/media/cache/skeleton-dance-1929");
    assert.ok(plan["1"].startSec >= 331 * 0.4 && plan["1"].startSec <= 331 * 0.6);
    assert.equal(keys.filter((key) => key === "leaderboard").length <= 1, true);
    assert.equal(keys.filter((key) => key === "pinboard").length <= 1, true);
  }
});

test("a pinned video with no cached clip stays a video screen", () => {
  const playlist = [
    { type: "logo", key: "pinnacle" },
    { type: "logo", key: "pinball-land" },
    { type: "amenity", id: "amenities", cycle: true },
    { type: "clock", id: "clock" },
    { type: "pinboard", id: "pinboard" },
  ];
  const layout = {
    1: { content: "video", enabled: true },
    2: { content: "logos", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  for (let tick = 0; tick < 8; tick += 1) {
    const plan = planRotation(playlist, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now: tick * 30000,
    });
    const keys = ["1", "2", "3"].map((slot) => rotationKey(plan[slot]));
    assert.equal(new Set(keys).size, 3, JSON.stringify(keys));
    assert.equal(plan["1"].type, "video");
    assert.equal(plan["1"].empty, true);
    assert.equal(plan["1"].url, "");
  }
});

test("videos keep being scheduled across two hours of stalls and a pin stays video", () => {
  const videos = ["reel-a", "reel-b", "reel-c", "reel-d"].map((id) => ({
    type: "video",
    id,
    url: `/media/cache/${id}`,
    durationSec: 180,
    local: true,
  }));
  const playlist = [
    { type: "logo", key: "pinnacle" },
    { type: "logo", key: "pinball-land" },
    { type: "amenity", id: "amenities", cycle: true },
    { type: "clock", id: "clock" },
    { type: "pinboard", id: "pinboard" },
    ...videos,
  ];
  const layout = {
    1: { content: "video", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  const blockMs = 10 * 60 * 1000;
  const blocked = new Map();
  const interval = 30 * 1000;
  const steps = Math.round((2.5 * 60 * 60 * 1000) / interval);
  let cursor = 0;
  let rotationVideos = 0;
  const seen = new Set();
  for (let step = 0; step < steps; step += 1) {
    const now = step * interval;
    if (step % 80 === 10) blocked.set(videos[step % videos.length].id, now + blockMs);
    for (const [id, until] of blocked) {
      if (until <= now) blocked.delete(id);
    }
    const marked = playlist.map((card) => (
      card.type === "video" && (blocked.get(card.id) || 0) > now ? { ...card, blocked: true } : card
    ));
    const plan = planRotation(marked, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now,
      videoCursor: cursor,
    });
    assert.equal(plan["1"].type, "video", `pin left video at step ${step}`);
    assert.ok(plan["1"].url, `pin had no clip at step ${step}`);
    assert.ok(plan["1"].startSec >= 180 * 0.4 && plan["1"].startSec <= 180 * 0.6);
    for (const slot of ["2", "3"]) {
      if (plan[slot]?.type === "video") {
        rotationVideos += 1;
        seen.add(plan[slot].id);
        assert.notEqual(plan[slot].blocked, true);
      }
    }
    if (step % 50 === 5) {
      blocked.set(plan["1"].id, now + blockMs);
      cursor += 1;
    }
  }
  assert.ok(rotationVideos > 40, `scheduled video slots ${rotationVideos}`);
  assert.ok(seen.size >= 3, `clips seen in rotation: ${[...seen].join(",")}`);

  const allBlocked = playlist.map((card) => (card.type === "video" ? { ...card, blocked: true } : card));
  const stuck = planRotation(allBlocked, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout,
    now: steps * interval,
    videoCursor: cursor,
  });
  assert.equal(stuck["1"].type, "video");
  assert.ok(stuck["1"].url);

  let returned = false;
  for (let tick = 0; tick < 40; tick += 1) {
    const plan = planRotation(playlist, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now: (steps * interval) + blockMs + tick * interval,
      videoCursor: 0,
    });
    if (plan["2"]?.type === "video" || plan["3"]?.type === "video") returned = true;
  }
  assert.equal(returned, true);
});

test("pinned screens keep one clip and never share it", () => {
  const videos = ["a", "b", "c", "d", "e"].map((id) => ({
    type: "video", id, url: `/media/cache/${id}`, durationSec: 400,
  }));
  const playlist = [
    { type: "logo", key: "pinnacle" },
    { type: "logo", key: "pinball-land" },
    { type: "clock", id: "clock" },
    ...videos,
  ];
  const layout = {
    1: { content: "video", enabled: true },
    2: { content: "video", enabled: true },
    3: { content: "video", enabled: true },
  };
  const memory = { 1: { gen: 0, id: "" }, 2: { gen: 0, id: "" }, 3: { gen: 0, id: "" } };
  const first = planRotation(playlist, { startedAt: 0, intervalSec: 30, screenCount: 3, layout, now: 0, videoMemory: memory });
  for (const slot of ["1", "2", "3"]) {
    memory[slot] = { gen: 0, id: first[slot].id };
    assert.equal(first[slot].type, "video");
    assert.ok(first[slot].startSec >= 160 && first[slot].startSec <= 240);
  }
  const ids = ["1", "2", "3"].map((slot) => first[slot].id);
  assert.equal(new Set(ids).size, 3);
  const later = planRotation(playlist, { startedAt: 0, intervalSec: 30, screenCount: 3, layout, now: 45000, videoMemory: memory });
  assert.deepEqual(["1", "2", "3"].map((slot) => later[slot].id), ids);
  memory["1"] = { gen: 1, id: "" };
  const advanced = planRotation(playlist, { startedAt: 0, intervalSec: 30, screenCount: 3, layout, now: 45000, videoMemory: memory });
  assert.notEqual(advanced["1"].id, first["1"].id);
  assert.equal(advanced["2"].id, first["2"].id);
  assert.equal(advanced["3"].id, first["3"].id);
  const keys = ["1", "2", "3"].map((slot) => rotationKey(advanced[slot]));
  assert.equal(new Set(keys).size, 3);
});

test("rotation changes every screen on the interval, not between ticks", () => {
  const playlist = buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] });
  const layout = {
    1: { content: "rotation", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  const startedAt = 5_000_000;
  const keys = (now) => {
    const plan = planRotation(playlist, { startedAt, intervalSec: 30, screenCount: 3, layout, now });
    return ["1", "2", "3"].map((slot) => rotationKey(plan[slot]));
  };
  const early = keys(startedAt + 1000);
  assert.deepEqual(keys(startedAt + 14000), early);
  const flipped = keys(startedAt + 16000);
  assert.deepEqual(keys(startedAt + 29000), flipped);
  assert.notDeepEqual(flipped, early);
  const next = keys(startedAt + 30000);
  assert.notDeepEqual(next, flipped);
  assert.equal(new Set(next).size, 3);
  assert.deepEqual(keys(startedAt + 30000 + 500), next);
});

test("one holiday clip is never copied, and a season with none stays on non-video screens", () => {
  const clip = {
    type: "video",
    id: "starter:skeleton-dance-1929",
    url: "/media/cache/skeleton-dance-1929",
    durationSec: 331,
    local: true,
  };
  const playlist = buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] }, {
    starters: [clip],
  });
  const layout = {
    1: { content: "rotation", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  let sawVideo = false;
  for (let tick = 0; tick < 24; tick += 1) {
    const plan = planRotation(playlist, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now: tick * 30000,
    });
    const cards = ["1", "2", "3"].map((slot) => plan[slot]);
    const keys = cards.map((card) => rotationKey(card));
    assert.equal(new Set(keys).size, 3, JSON.stringify(keys));
    const videos = cards.filter((card) => card?.type === "video");
    assert.ok(videos.length <= 1, JSON.stringify(videos.map((card) => card.id)));
    for (const card of videos) {
      assert.equal(card.id, clip.id);
      assert.equal(card.url, clip.url);
      sawVideo = true;
    }
    for (const card of cards) {
      if (card?.type === "video") continue;
      assert.ok(["logo", "amenity", "clock", "pinboard"].includes(card.type), card?.type);
    }
  }
  assert.equal(sawVideo, true);

  const pinned = {
    1: { content: "video", enabled: true },
    2: { content: "video", enabled: true },
    3: { content: "video", enabled: true },
  };
  const shared = planRotation(playlist, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout: pinned,
    now: 0,
  });
  const pinnedVideos = ["1", "2", "3"].map((slot) => shared[slot]).filter((card) => card?.type === "video" && card.url);
  assert.equal(pinnedVideos.length, 1);
  assert.equal(pinnedVideos[0].id, clip.id);
  for (const slot of ["1", "2", "3"]) {
    const card = shared[slot];
    if (card?.type === "video" && card.url) continue;
    assert.ok(["logo", "amenity", "clock", "pinboard"].includes(card.type), JSON.stringify(card));
  }

  const quiet = buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] });
  for (let tick = 0; tick < 12; tick += 1) {
    const plan = planRotation(quiet, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now: tick * 30000,
    });
    const cards = ["1", "2", "3"].map((slot) => plan[slot]);
    assert.equal(cards.some((card) => card?.type === "video"), false);
    assert.equal(new Set(cards.map((card) => rotationKey(card))).size, 3);
  }
});

test("a holiday clip walks left, center, right and stays for the whole dwell", () => {
  const playlist = buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] }, {
    starters: [
      { type: "video", id: "starter:skeleton-dance-1929", url: "/media/cache/skeleton-dance-1929", durationSec: 331, holiday: "halloween" },
      { type: "video", id: "starter:christmas-comes-1936", url: "/media/cache/christmas-comes-1936", durationSec: 498, holiday: "christmas" },
    ],
  });
  const layout = {
    1: { content: "rotation", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  const at = (tick) => planRotation(playlist, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout,
    now: tick * 30000,
  });
  const order = ["1", "2", "3"];
  for (let tick = 0; tick < 9; tick += 1) {
    const plan = at(tick);
    const urls = ["1", "2", "3"].map((slot) => (plan[slot]?.type === "video" ? plan[slot].url : "")).filter(Boolean);
    assert.equal(urls.length, 1, JSON.stringify(urls));
    const owner = order[tick % 3];
    assert.equal(plan[owner].type, "video");
    assert.match(plan[owner].url, /skeleton-dance-1929|christmas-comes-1936/);
    const mid = planRotation(playlist, {
      startedAt: 0,
      intervalSec: 30,
      screenCount: 3,
      layout,
      now: tick * 30000 + 15000,
    });
    assert.equal(mid[owner].playId, plan[owner].playId);
  }
});

test("two cards with the same file never share a screen", () => {
  const playlist = buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] }, {
    starters: [
      { type: "video", id: "starter:one", url: "/media/cache/same.mp4", durationSec: 400, local: true },
      { type: "video", id: "starter:two", url: "/media/cache/same.mp4", durationSec: 400, local: true },
    ],
  });
  const layout = {
    1: { content: "video", enabled: true },
    2: { content: "video", enabled: true },
    3: { content: "video", enabled: true },
  };
  const plan = planRotation(playlist, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout,
    now: 0,
  });
  const videos = ["1", "2", "3"].map((slot) => plan[slot]).filter((card) => card?.type === "video" && card.url);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].url, "/media/cache/same.mp4");
  for (const slot of ["1", "2", "3"]) {
    const card = plan[slot];
    if (card?.type === "video" && card.url) continue;
    assert.notEqual(card?.type, "video");
  }
});

test("logo screens swap together at halfway and never share a logo", () => {
  const playlist = buildPlaylist({ rotation: normalizeRotation({}), leaderboards: [] }, {
    starters: [{ type: "video", id: "skeleton-dance-1929", url: "/media/cache/skeleton-dance-1929", durationSec: 331 }],
  });
  const layout = {
    1: { content: "rotation", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  const startedAt = 8_000_000;
  const keysAt = (now) => {
    const plan = planRotation(playlist, {
      startedAt,
      intervalSec: 1,
      minInterval: 1,
      screenCount: 3,
      layout,
      now,
    });
    return ["1", "2", "3"].map((slot) => rotationKey(plan[slot]));
  };
  for (let sec = 0; sec < 12; sec += 1) {
    for (const into of [100, 400, 600, 900]) {
      const keys = keysAt(startedAt + sec * 1000 + into);
      assert.equal(new Set(keys).size, 3, JSON.stringify(keys));
    }
  }
  const first = keysAt(startedAt + 200);
  const second = keysAt(startedAt + 700);
  assert.notDeepEqual(first, second);
  const logos = (keys) => keys.filter((key) => key.startsWith("logo:"));
  assert.notDeepEqual(logos(first), logos(second));
  assert.equal(new Set(logos(second)).size, logos(second).length);
});

test("a logo card flips at the halfway point of its dwell", () => {
  const startedAt = 10_000;
  assert.equal(logoPhaseKey("pinnacle", startedAt, 30, startedAt + 1000), "pinnacle");
  assert.equal(logoPhaseKey("pinnacle", startedAt, 30, startedAt + 14999), "pinnacle");
  assert.equal(logoPhaseKey("pinnacle", startedAt, 30, startedAt + 15000), "pinball-land");
  assert.equal(logoPhaseKey("pinball-land", startedAt, 30, startedAt + 1000), "pinball-land");
  assert.equal(logoPhaseKey("pinball-land", startedAt, 30, startedAt + 15000), "pinnacle");
  assert.equal(logoPhaseKey("pinnacle", startedAt, 30, startedAt + 30000), "pinnacle");
  const left = logoPhaseKey("pinnacle", startedAt, 30, startedAt + 20000);
  const right = logoPhaseKey("pinball-land", startedAt, 30, startedAt + 20000);
  assert.notEqual(left, right);
});

test("a failed video is replaced without duplicating a logo", () => {
  const playlist = [
    { type: "logo", key: "pinnacle" },
    { type: "logo", key: "pinball-land" },
    { type: "amenity", id: "amenities" },
    { type: "clock", id: "clock" },
    { type: "video", id: "only", url: "/media/cache/only", durationSec: 120 },
  ];
  const plan = {
    1: { type: "video", id: "only", url: "/media/cache/only" },
    2: { type: "logo", key: "pinnacle" },
    3: { type: "logo", key: "pinball-land" },
  };
  const next = replacementFor(plan, "1", playlist, { failedIds: ["only"], salt: "1:give-up" });
  assert.notEqual(next.type, "video");
  const keys = [rotationKey(next), rotationKey(plan["2"]), rotationKey(plan["3"])];
  assert.equal(new Set(keys).size, 3, JSON.stringify(keys));
  assert.notEqual(rotationKey(next), "logo:pinnacle");
  assert.notEqual(rotationKey(next), "logo:pinball-land");
});
