const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadCatalog, starterCards } = require("../src/catalog");
const { seasonsOn, starterThemes } = require("../src/season");
const { buildPlaylist, planRotation, normalizeRotation } = require("../src/playlist");

const OCT18 = Date.parse("2026-10-18T18:18:44-07:00");
const JULY4 = Date.parse("2026-07-04T15:00:00-07:00");
const DEC18 = Date.parse("2026-12-18T18:00:00-08:00");
const catalog = loadCatalog(path.join(__dirname, "..", "media", "catalog.json"));

const layout = {
  1: { content: "rotation", enabled: true },
  2: { content: "rotation", enabled: true },
  3: { content: "rotation", enabled: true },
};

function playlistFor(theme, now) {
  const previous = process.env.PINBALL_STARTER_THEMES;
  delete process.env.PINBALL_STARTER_THEMES;
  try {
    const starters = starterThemes(theme, now).flatMap((holiday) => starterCards(catalog, {
      theme: holiday,
      allAges: true,
      isReady: () => true,
      urlFor: (id) => `/media/cache/${id}`,
    }));
    return buildPlaylist({
      theme,
      rotation: normalizeRotation({}),
      leaderboards: [],
    }, { starters, pinboard: true });
  } finally {
    if (previous === undefined) delete process.env.PINBALL_STARTER_THEMES;
    else process.env.PINBALL_STARTER_THEMES = previous;
  }
}

function videoUrls(plan) {
  return ["1", "2", "3"].map((slot) => (plan[slot]?.type === "video" ? plan[slot].url : ""));
}

test("pacific dates pick halloween through november 1 and christmas through the 26th", () => {
  const previous = process.env.PINBALL_STARTER_THEMES;
  delete process.env.PINBALL_STARTER_THEMES;
  try {
    assert.deepEqual(seasonsOn(OCT18), ["halloween"]);
    assert.deepEqual(seasonsOn(Date.parse("2026-10-01T00:30:00-07:00")), ["halloween"]);
    assert.deepEqual(seasonsOn(Date.parse("2026-11-01T20:00:00-08:00")), ["halloween"]);
    assert.deepEqual(seasonsOn(Date.parse("2026-11-02T12:00:00-08:00")), []);
    assert.deepEqual(seasonsOn(Date.parse("2026-09-30T23:30:00-07:00")), []);
    assert.deepEqual(seasonsOn(JULY4), []);
    assert.deepEqual(seasonsOn(DEC18), ["christmas"]);
    assert.deepEqual(seasonsOn(Date.parse("2026-12-01T00:30:00-08:00")), ["christmas"]);
    assert.deepEqual(seasonsOn(Date.parse("2026-12-26T21:00:00-08:00")), ["christmas"]);
    assert.deepEqual(seasonsOn(Date.parse("2026-12-27T12:00:00-08:00")), []);
    assert.deepEqual(starterThemes("pinnacle", OCT18), ["halloween"]);
    assert.deepEqual(starterThemes("christmas", OCT18), ["halloween", "christmas"]);
    assert.deepEqual(starterThemes("halloween", OCT18), ["halloween"]);
    assert.deepEqual(starterThemes("pinnacle", JULY4), []);
    assert.deepEqual(starterThemes("halloween", JULY4), ["halloween"]);
    assert.deepEqual(starterThemes("pinnacle", DEC18), ["christmas"]);
    assert.ok(catalog.some((item) => item.id === "skeleton-dance-1929" && item.holiday === "halloween"));
    assert.ok(catalog.some((item) => item.id === "christmas-comes-1936" && item.holiday === "christmas"));
  } finally {
    if (previous === undefined) delete process.env.PINBALL_STARTER_THEMES;
    else process.env.PINBALL_STARTER_THEMES = previous;
  }
});

test("the real catalog gives each in-season clip one screen and never a second", () => {
  const cases = [
    { theme: "pinnacle", now: OCT18, skeleton: 1, christmas: 0 },
    { theme: "halloween", now: OCT18, skeleton: 1, christmas: 0 },
    { theme: "christmas", now: OCT18, skeleton: 1, christmas: 1 },
    { theme: "pinnacle", now: JULY4, skeleton: 0, christmas: 0 },
    { theme: "halloween", now: JULY4, skeleton: 1, christmas: 0 },
    { theme: "pinnacle", now: DEC18, skeleton: 0, christmas: 1 },
  ];
  for (const item of cases) {
    const playlist = playlistFor(item.theme, item.now);
    let previous = null;
    const homes = new Map();
    for (let tick = 0; tick < 16; tick += 1) {
      const plan = planRotation(playlist, {
        startedAt: 0,
        intervalSec: 30,
        screenCount: 3,
        layout,
        now: item.now + tick * 30000,
      });
      const urls = videoUrls(plan).filter(Boolean);
      const skeleton = urls.filter((url) => url.includes("skeleton-dance-1929"));
      const christmas = urls.filter((url) => url.includes("christmas-comes-1936"));
      assert.equal(skeleton.length, item.skeleton, `${item.theme} tick ${tick}`);
      assert.equal(christmas.length, item.christmas, `${item.theme} tick ${tick}`);
      assert.equal(new Set(urls).size, urls.length, `${item.theme} tick ${tick}`);
      for (const slot of ["1", "2", "3"]) {
        const url = plan[slot]?.type === "video" ? plan[slot].url : "";
        if (!url) continue;
        if (!homes.has(url)) homes.set(url, slot);
        assert.equal(homes.get(url), slot, `${url} moved`);
        if (previous) {
          for (const other of ["1", "2", "3"]) {
            if (other === slot) continue;
            const otherUrl = previous[other]?.type === "video" ? previous[other].url : "";
            assert.notEqual(url, otherUrl, `${url} slid onto slot ${slot}`);
          }
        }
      }
      previous = plan;
    }
  }
});
