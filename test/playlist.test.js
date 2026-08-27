const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AMENITIES, AMENITY_IDS, getAmenity } = require("../src/amenities");
const {
  buildPlaylist,
  cardForSlot,
  currentTick,
  slotIndexForDisplay,
  normalizeRotation,
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

test("rotation defaults on with a 14s interval", () => {
  const rotation = normalizeRotation(undefined);
  assert.equal(rotation.enabled, true);
  assert.equal(rotation.intervalSec, 14);
  assert.equal(rotation.items.logoPinnacle, true);
  assert.equal(rotation.items.amenityOasis, true);
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
      "amenity:arcade",
      "amenity:oasis",
      "amenity:events",
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
        amenityArcade: false,
        amenityOasis: false,
        amenityEvents: false,
      },
    }),
    leaderboards: [
      { id: "hidden", inRotation: false },
      { id: "shown", inRotation: true },
    ],
  });
  assert.deepEqual(
    playlist.map((card) => card.type + ":" + (card.key || card.id)),
    ["logo:pinball-land", "leaderboard:shown"]
  );
});
