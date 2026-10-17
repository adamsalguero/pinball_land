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
  AMENITY_DWELL_SEC,
} = require("../src/playlist");

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
  assert.ok(start > 10);
  assert.ok(start < 300);
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

test("screens change apart and amenities cycle inside one card", () => {
  const startedAt = 1_000_000;
  assert.equal(tickForSlot(startedAt, 25, 0, 3, startedAt + 25000), 1);
  assert.equal(tickForSlot(startedAt, 25, 1, 3, startedAt + 25000), 0);
  assert.equal(tickForSlot(startedAt, 25, 1, 3, startedAt + 25000 + 25000 / 3), 1);
  assert.equal(amenityAt(0, 0, 0), "arcade");
  assert.equal(amenityAt(0, 0, AMENITY_DWELL_SEC * 1000), "oasis");
  assert.equal(amenityAt(0, 0, AMENITY_DWELL_SEC * 2000), "events");
  assert.equal(amenityAt(0, 0, AMENITY_DWELL_SEC * 3000), "arcade");
});
