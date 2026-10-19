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
    assert.deepEqual(starterThemes("pinnacle", OCT18), []);
    assert.deepEqual(starterThemes("christmas", OCT18), ["christmas"]);
    assert.deepEqual(starterThemes("halloween", OCT18), ["halloween"]);
    assert.deepEqual(starterThemes("pinnacle", JULY4), []);
    assert.deepEqual(starterThemes("halloween", JULY4), ["halloween"]);
    assert.deepEqual(starterThemes("christmas", JULY4), ["christmas"]);
    assert.deepEqual(starterThemes("pinnacle", DEC18), []);
    assert.deepEqual(starterThemes("christmas", DEC18), ["christmas"]);
    assert.ok(catalog.some((item) => item.id === "skeleton-dance-1929" && item.holiday === "halloween"));
    assert.ok(catalog.some((item) => item.id === "christmas-comes-1936" && item.holiday === "christmas"));
  } finally {
    if (previous === undefined) delete process.env.PINBALL_STARTER_THEMES;
    else process.env.PINBALL_STARTER_THEMES = previous;
  }
});

test("the real catalog gives each in-season clip one screen and never a second", () => {
  const cases = [
    { theme: "pinnacle", now: OCT18, skeleton: 0, christmas: 0 },
    { theme: "halloween", now: OCT18, skeleton: 1, christmas: 0 },
    { theme: "christmas", now: OCT18, skeleton: 0, christmas: 1 },
    { theme: "pinnacle", now: JULY4, skeleton: 0, christmas: 0 },
    { theme: "halloween", now: JULY4, skeleton: 1, christmas: 0 },
    { theme: "christmas", now: JULY4, skeleton: 0, christmas: 1 },
    { theme: "pinnacle", now: DEC18, skeleton: 0, christmas: 0 },
    { theme: "christmas", now: DEC18, skeleton: 0, christmas: 1 },
  ];
  for (const item of cases) {
    const playlist = playlistFor(item.theme, item.now);
    for (let tick = 0; tick < 16; tick += 1) {
      const now = item.now + tick * 30000;
      const plan = planRotation(playlist, {
        startedAt: 0,
        intervalSec: 30,
        screenCount: 3,
        layout,
        now,
      });
      const urls = videoUrls(plan).filter(Boolean);
      const skeleton = urls.filter((url) => url.includes("skeleton-dance-1929"));
      const christmas = urls.filter((url) => url.includes("christmas-comes-1936"));
      assert.equal(skeleton.length, item.skeleton, `${item.theme} tick ${tick}`);
      assert.equal(christmas.length, item.christmas, `${item.theme} tick ${tick}`);
      assert.equal(new Set(urls).size, urls.length, `${item.theme} tick ${tick}`);
      if (item.skeleton || item.christmas) {
        const dwell = Math.floor(now / 30000);
        const owner = String((dwell % 3) + 1);
        assert.equal(plan[owner]?.type, "video", `${item.theme} tick ${tick} slot ${owner}`);
      }
      if (item.theme === "pinnacle") {
        for (const slot of ["1", "2", "3"]) {
          assert.notEqual(plan[slot]?.type, "video", `pinnacle tick ${tick} slot ${slot}`);
        }
      }
      if (item.theme === "christmas") {
        assert.equal(urls.some((url) => url.includes("christmas-comes-1936")), true);
      }
    }
  }
});

test("the regular theme shows no video, and switching to Christmas starts Christmas Comes", () => {
  const library = {
    id: "library-loop",
    title: "Lobby",
    folder: "library",
    tags: [],
    allAges: true,
    inRotation: true,
    url: "/media/videos/library-loop",
  };
  const october = playlistFor("pinnacle", OCT18);
  const withLibrary = buildPlaylist({
    theme: "pinnacle",
    rotation: normalizeRotation({}),
    leaderboards: [],
  }, { videos: [library], pinboard: true });
  assert.equal(october.some((card) => card.type === "video"), false);
  assert.equal(withLibrary.some((card) => card.type === "video"), false);
  const halloween = playlistFor("halloween", OCT18);
  const christmas = playlistFor("christmas", OCT18);
  const halloweenPlan = planRotation(halloween, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout,
    now: OCT18,
  });
  const christmasPlan = planRotation(christmas, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout,
    now: OCT18,
  });
  const regularPlan = planRotation(october, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout,
    now: OCT18,
  });
  assert.equal(videoUrls(halloweenPlan).some((url) => url.includes("skeleton-dance-1929")), true);
  assert.equal(videoUrls(halloweenPlan).some((url) => url.includes("christmas-comes-1936")), false);
  assert.equal(videoUrls(christmasPlan).filter((url) => url.includes("christmas-comes-1936")).length, 1);
  assert.equal(videoUrls(christmasPlan).some((url) => url.includes("skeleton-dance-1929")), false);
  assert.deepEqual(videoUrls(regularPlan).filter(Boolean), []);
  for (const slot of ["1", "2", "3"]) assert.notEqual(regularPlan[slot]?.type, "video");

  const skeletonPin = {
    1: { content: "video", clipId: "skeleton-dance-1929", enabled: true },
    2: { content: "rotation", enabled: true },
    3: { content: "rotation", enabled: true },
  };
  const halloweenPin = planRotation(halloween, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout: skeletonPin,
    now: OCT18,
  });
  assert.match(halloweenPin["1"].url, /skeleton-dance-1929/);
  assert.equal(halloweenPin["1"].title, "The Skeleton Dance");
  assert.notEqual(halloweenPin["2"].type, "video");
  assert.notEqual(halloweenPin["3"].type, "video");
  const replay = planRotation(halloween, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout: skeletonPin,
    now: OCT18,
    videoMemory: { 1: { gen: 1, id: "" } },
  });
  assert.equal(replay["1"].id, halloweenPin["1"].id);
  assert.notEqual(replay["1"].playId, halloweenPin["1"].playId);
  const regularPin = planRotation(october, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout: skeletonPin,
    now: OCT18,
  });
  for (const slot of ["1", "2", "3"]) assert.notEqual(regularPin[slot]?.type, "video");
  const christmasPin = planRotation(christmas, {
    startedAt: 0,
    intervalSec: 30,
    screenCount: 3,
    layout: {
      1: { content: "video", clipId: "christmas-comes-1936", enabled: true },
      2: { content: "rotation", enabled: true },
      3: { content: "rotation", enabled: true },
    },
    now: OCT18,
  });
  assert.match(christmasPin["1"].url, /christmas-comes-1936/);
  assert.equal(christmasPin["1"].title, "Christmas Comes But Once a Year");
  assert.doesNotMatch(christmasPin["1"].url, /skeleton-dance/);
});
