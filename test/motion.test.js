const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createField, stepField } = require("../public/motion");
const { normalizeMotion } = require("../src/config");

test("transitions are subtle or off, and particles move on their own canvas field", () => {
  assert.equal(normalizeMotion("full"), "subtle");
  assert.equal(normalizeMotion("dark"), "subtle");
  assert.equal(normalizeMotion("off"), "off");
  assert.equal(normalizeMotion(undefined), "subtle");

  const { worldPoint, screenPoint, spiderSilk, WORLD_W, SLICE_W } = require("../public/motion");
  const halloween = createField("halloween", 2);
  assert.equal(halloween.particles.length, 24);
  assert.ok(halloween.particles.some((particle) => particle.kind === "pumpkin"));
  assert.ok(halloween.particles.some((particle) => particle.kind === "spider"));
  assert.ok(halloween.particles.some((particle) => particle.kind === "candy"));
  assert.ok(halloween.particles.some((particle) => particle.kind === "bat"));
  const other = createField("halloween", 2);
  const elapsed = 12.5;
  const world = worldPoint(halloween.particles[0], elapsed);
  const again = worldPoint(other.particles[0], elapsed);
  assert.equal(world.x, again.x);
  assert.equal(world.y, again.y);
  const left = screenPoint({ x: 400, y: 220 }, 0, 1920, 1080);
  const intoNext = screenPoint({ x: 400 + SLICE_W, y: 220 }, 1, 1920, 1080);
  assert.ok(Math.abs(left.x - intoNext.x) < 0.01);
  assert.ok(Math.abs(left.y - intoNext.y) < 0.01);
  assert.equal(WORLD_W, SLICE_W * 3);
  const silk = spiderSilk(screenPoint({ x: 400, y: 240 }, 0, 1920, 1080));
  assert.equal(silk.y1, 0);
  assert.equal(silk.x1, silk.x2);
  assert.equal(silk.y2, 240);
  const sliced = spiderSilk(screenPoint({ x: SLICE_W + 180, y: 310 }, 1, 1920, 1080));
  assert.equal(sliced.y1, 0);
  assert.ok(Math.abs(sliced.x1 - 180) < 0.01);
  assert.ok(Math.abs(sliced.y2 - 310) < 0.01);
  const later = worldPoint(halloween.particles.find((particle) => particle.kind === "bat"), elapsed + 4);
  const earlier = worldPoint(halloween.particles.find((particle) => particle.kind === "bat"), elapsed);
  assert.notEqual(later.x, earlier.x);
  stepField(halloween, 0.5);
  assert.ok(halloween.elapsed > 0);

  const christmas = createField("christmas", 2);
  assert.ok(christmas.particles.some((particle) => particle.kind === "snow"));
  assert.ok(christmas.particles.some((particle) => particle.kind === "ornament"));
  assert.ok(christmas.particles.length <= 48);

  const plain = createField("pinnacle", 2);
  assert.ok(plain.particles.length <= 12);
  assert.ok(plain.particles.every((particle) => particle.kind === "mote"));
});
