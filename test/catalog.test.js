const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { catalogProblems, loadCatalog } = require("../src/catalog");

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
});
