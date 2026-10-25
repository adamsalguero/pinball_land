const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { pickArtUrl, pickCabinetUrl, createOpdb, EXPORT_URL } = require("../src/opdb");
const { isGuestRoute } = require("../src/tunnel");

test("cabinet art is a cabinet photo and wall art stays the backglass", () => {
  const machine = {
    images: [
      { type: "backglass", urls: { large: "https://img.example/back.png" } },
      { type: "translite", title: "cabinet translite", urls: { large: "https://img.example/trans.png" } },
      { type: "playfield", urls: { large: "https://img.example/play.png" } },
      { type: "cabinet", title: "Full cabinet", urls: { medium: "https://img.example/cab.png" } },
    ],
  };
  assert.equal(pickArtUrl(machine), "https://img.example/back.png");
  assert.equal(pickCabinetUrl(machine), "https://img.example/cab.png");
  assert.equal(pickCabinetUrl({ images: [{ type: "backglass", urls: { large: "https://img.example/back.png" } }] }), null);
  assert.equal(pickCabinetUrl({ images: [{ type: "cabinet", title: "backglass cabinet", urls: { large: "https://img.example/nope.png" } }] }), null);
});

test("catalog search returns Jaws variants and skips a group", async () => {
  const catalog = JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "opdb-catalog.json"), "utf8"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-opdb-"));
  const opdb = createOpdb({
    cacheDir: dir,
    fetchImpl: async (url) => {
      if (String(url).includes("opdb-v2.json")) return { ok: true, json: async () => catalog };
      throw new Error(`unexpected ${url}`);
    },
  });
  const rows = await opdb.search("jaws");
  const names = rows.map((row) => row.name);
  assert.deepEqual(names, [
    "JAWS (Pro)",
    "JAWS (Premium)",
    "JAWS (LE)",
    "Jaws (50th anniversary)",
  ]);
  assert.equal(rows.every((row) => row.manufacturer === "Stern" && row.cabinet === false), true);
  assert.equal(rows.find((row) => row.name === "JAWS (Pro)").edition, "Pro edition");
  assert.equal(rows.find((row) => row.name === "JAWS (Premium)").year, "2024");
  const beatles = await opdb.search("beatles");
  assert.equal(beatles[0].cabinet, true);
  assert.equal(EXPORT_URL.includes("opdb-v2.json"), true);
});

test("an unreachable catalog still searches the bundled export, including edition aliases", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-opdb-offline-"));
  const opdb = createOpdb({
    apiKey: "",
    cacheDir: dir,
    fetchImpl: async () => {
      throw new Error("catalog unreachable");
    },
  });
  const rows = await opdb.search("jaws");
  const names = rows.map((row) => row.name);
  for (const name of ["JAWS (Pro)", "JAWS (Premium)", "JAWS (LE)", "Jaws (50th anniversary)"]) {
    assert.ok(names.includes(name), names.join(", "));
  }
  assert.equal(names.includes("JAWS"), false);
  assert.equal(names.includes("JAWS (Premium/LE)"), false);
});

test("guest routes include machine search and cabinet photos", () => {
  assert.equal(isGuestRoute({ method: "GET", path: "/api/opdb/search" }), true);
  assert.equal(isGuestRoute({ method: "GET", path: "/api/opdb/cabinet/GLWll-MXr4N" }), true);
  assert.equal(isGuestRoute({ method: "POST", path: "/api/opdb/boards" }), true);
  assert.equal(isGuestRoute({ method: "GET", path: "/machine-gallery.js" }), true);
  assert.equal(isGuestRoute({ method: "GET", path: "/machine-gallery.css" }), true);
  assert.equal(isGuestRoute({ method: "POST", path: "/api/opdb/search" }), false);
  assert.equal(isGuestRoute({ method: "GET", path: "/api/machines" }), false);
});
