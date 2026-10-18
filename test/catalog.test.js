const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { catalogProblems, loadCatalog, starterCards, purgeRemovedStarters, removedStarterId } = require("../src/catalog");
const { normalizeSlogans } = require("../src/config");

test("video catalog entries are well-formed, unique, and Christmas is color", () => {
  const filePath = path.join(__dirname, "..", "media", "catalog.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const problems = catalogProblems(raw.items);
  assert.deepEqual(problems, []);
  const loaded = loadCatalog(filePath);
  assert.equal(loaded.length, raw.items.length);
  const ids = loaded.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const urls = loaded.map((item) => item.streamUrl);
  assert.equal(new Set(urls).size, urls.length);
  for (const item of loaded) {
    assert.match(item.streamUrl, /^https:\/\/(archive\.org|upload\.wikimedia\.org)\//);
    assert.match(item.id, /^[a-z0-9-]{3,80}$/);
    assert.ok(item.durationSec > 30);
    if (item.holiday === "christmas") assert.equal(item.color, true);
  }
  assert.deepEqual(loaded.filter((item) => item.holiday === "halloween").map((item) => item.id), ["skeleton-dance-1929"]);
  assert.deepEqual(loaded.filter((item) => item.holiday === "christmas").map((item) => item.id), ["christmas-comes-1936"]);
  assert.deepEqual(starterCards(loaded, { theme: "pinnacle", isReady: () => true }), []);
  assert.deepEqual(starterCards(loaded, { theme: "halloween", isReady: () => false }), []);
  const ready = starterCards(loaded, {
    theme: "halloween",
    isReady: (id) => id === "skeleton-dance-1929",
    urlFor: (id) => `/media/cache/${id}`,
  });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].url, "/media/cache/skeleton-dance-1929");
  assert.equal(ready[0].stream, false);
  assert.equal(ready[0].local, true);
  const christmas = starterCards(loaded, {
    theme: "christmas",
    isReady: () => true,
    urlFor: (id) => `/media/cache/${id}`,
  });
  assert.ok(christmas.length >= 1);
  assert.ok(christmas.every((card) => card.color === true));
  assert.equal(raw.items.some((item) => item.id === "santas-surprise-1947"), false);
  assert.equal(raw.items.some((item) => item.id === "good-will-to-men-1955"), false);
  assert.equal(raw.items.some((item) => item.id === "swing-you-sinners-1930"), false);
  assert.equal(removedStarterId("santas-surprise-1947"), true);
  assert.equal(removedStarterId("good-will-to-men-1955"), true);
  assert.equal(removedStarterId("swing-you-sinners-1930"), true);
  assert.equal(removedStarterId("starter:good-will-to-men-1955"), true);
  assert.equal(removedStarterId("starter:swing-you-sinners-1930"), true);
  const blocked = path.join(os.tmpdir(), `pinball-catalog-${Date.now()}.json`);
  fs.writeFileSync(blocked, JSON.stringify({
    items: [
      ...raw.items,
      {
        id: "santas-surprise-1947",
        title: "Santa's Surprise",
        holiday: "christmas",
        allAges: true,
        color: true,
        streamUrl: "https://archive.org/download/santas-surprise-1947/Santa%27s%20Surprise%20%281947%29.mp4",
        durationSec: 501,
      },
      {
        id: "swing-you-sinners-1930",
        title: "Swing You Sinners!",
        holiday: "halloween",
        allAges: true,
        color: false,
        streamUrl: "https://archive.org/download/swing-you-sinners-1930/Swing_You_Sinners%21_by_Fleischer_Studios_%281930%29.mp4",
        durationSec: 496,
      },
    ],
  }));
  const filtered = loadCatalog(blocked);
  fs.unlinkSync(blocked);
  assert.equal(filtered.some((item) => item.id === "santas-surprise-1947"), false);
  assert.equal(filtered.some((item) => item.id === "swing-you-sinners-1930"), false);
  assert.equal(starterCards(filtered, {
    theme: "christmas",
    isReady: () => true,
    urlFor: (id) => `/media/cache/${id}`,
  }).some((card) => card.id.includes("santas-surprise")), false);
  assert.deepEqual(starterCards(filtered, {
    theme: "halloween",
    isReady: () => true,
    urlFor: (id) => `/media/cache/${id}`,
  }).map((card) => card.id), ["starter:skeleton-dance-1929"]);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinball-santa-"));
  const cached = path.join(cacheDir, "santas-surprise-1947.mp4");
  const goodWill = path.join(cacheDir, "good-will-to-men-1955.mp4");
  const swing = path.join(cacheDir, "swing-you-sinners-1930.mp4");
  fs.writeFileSync(cached, "remove me");
  fs.writeFileSync(path.join(cacheDir, "santas-surprise-1947"), "remove me");
  fs.writeFileSync(goodWill, "remove me");
  fs.writeFileSync(swing, "remove me");
  fs.writeFileSync(path.join(cacheDir, "swing-you-sinners-1930.mp4.part"), "remove me");
  const gone = purgeRemovedStarters(cacheDir);
  assert.equal(fs.existsSync(cached), false);
  assert.equal(fs.existsSync(goodWill), false);
  assert.equal(fs.existsSync(swing), false);
  assert.equal(gone.length, 5);
  const slogans = normalizeSlogans(undefined);
  assert.equal(slogans.pinnacle, "");
  assert.equal(slogans.halloween, "Happy Halloween!");
  assert.equal(slogans.christmas, "Merry Christmas!");
  assert.equal(normalizeSlogans({ halloween: "Happy Halloween" }).halloween, "Happy Halloween!");
  assert.equal(normalizeSlogans({ christmas: "Merry Christmas" }).christmas, "Merry Christmas!");
  assert.equal(normalizeSlogans({ halloween: "  Boo  " }).halloween, "Boo");
  assert.equal(normalizeSlogans({ halloween: "" }).halloween, "");
  assert.equal(normalizeSlogans({ christmas: "Merry Christmas!" }).christmas, "Merry Christmas!");
});
