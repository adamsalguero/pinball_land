const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { catalogProblems, loadCatalog, starterCards } = require("../src/catalog");
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
  assert.ok(loaded.some((item) => item.holiday === "halloween"));
  assert.ok(loaded.some((item) => item.holiday === "christmas"));
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
  const slogans = normalizeSlogans(undefined);
  assert.equal(slogans.pinnacle, "");
  assert.equal(slogans.halloween, "Happy Halloween");
  assert.equal(slogans.christmas, "Merry Christmas");
  assert.equal(normalizeSlogans({ halloween: "  Boo  " }).halloween, "Boo");
});
