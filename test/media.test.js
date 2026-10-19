const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { MediaLibrary, includeInRotation } = require("../src/media");
const { buildPlaylist } = require("../src/playlist");

test("holiday clips join rotation only for that theme, and all-ages can hide one", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-media-"));
  const library = new MediaLibrary({ root, catalogPath: path.join(root, "library.json") });
  const spooky = await library.add({
    filename: "bats.mp4",
    mime: "video/mp4",
    folder: "halloween",
    title: "Bats",
    tags: "bats",
    allAges: true,
    inRotation: false,
  });
  const late = await library.add({
    filename: "late.mp4",
    mime: "video/mp4",
    folder: "halloween",
    title: "Late",
    allAges: false,
  });
  const snow = await library.add({
    filename: "snow.webm",
    mime: "video/webm",
    folder: "christmas",
    title: "Snow",
    tags: ["snow"],
    allAges: "true",
  });
  await fs.writeFile(library.filePath(spooky), "spooky");
  await fs.writeFile(library.filePath(snow), "snow");
  const videos = library.list();
  const state = { theme: "halloween", rotation: { items: {} }, leaderboards: [] };
  const blocked = buildPlaylist(state, { videos, allAges: true }).filter((card) => card.type === "video");
  assert.deepEqual(blocked.map((card) => card.title), ["Bats"]);
  const open = buildPlaylist(state, { videos, allAges: false }).filter((card) => card.type === "video");
  assert.deepEqual(open.map((card) => card.id), [spooky.id, late.id]);
  const christmas = buildPlaylist({ ...state, theme: "christmas" }, { videos, allAges: true });
  assert.equal(christmas.some((card) => card.id === snow.id), true);
  assert.equal(christmas.some((card) => card.id === spooky.id), false);
  assert.equal(includeInRotation(library.get(snow.id), { theme: "pinnacle", allAges: true }), false);

  await library.update(snow.id, { inRotation: true, tags: "snow, family" });
  assert.equal(includeInRotation(library.get(snow.id), { theme: "pinnacle", allAges: true }), false);
  assert.equal(includeInRotation(library.get(snow.id), { theme: "christmas", allAges: true }), true);
  const regular = buildPlaylist({ theme: "pinnacle", rotation: { items: {} }, leaderboards: [] }, { videos, allAges: true });
  assert.equal(regular.some((card) => card.type === "video"), false);
  await assert.rejects(() => library.add({ filename: "notes.txt", mime: "text/plain", folder: "library" }), /mp4/);
});

test("installer script uses the official UxPlay and Bonjour checksums", async () => {
  const script = await fs.readFile(path.join(__dirname, "..", "scripts", "install-airplay-windows.ps1"), "utf8");
  assert.match(script, /https:\/\/github\.com\/leapbtw\/uxplay-windows\/releases\/download\/2\.0\.0\.1736\/uxplay-windows\.zip/);
  assert.match(script, /9d3a51c15fc9db857351195e7eb7bbb21700d9ae25d936a54bcf8536b62cca18/);
  assert.match(script, /https:\/\/download\.info\.apple\.com\/Mac_OS_X\/061-8098\.20100603\.gthyu\/BonjourPSSetup\.exe/);
  assert.match(script, /7f1ec347cd429cfb25a34b2147e02231334f28290e0c28be213415b0f99da1a0/);
  assert.match(script, /support\.apple\.com/);
  assert.doesNotMatch(script, /uxplay-windows-arm64/);
});
