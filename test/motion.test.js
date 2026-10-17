const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createField, stepField } = require("../public/motion");
const { normalizeMotion } = require("../src/config");

test("transitions are subtle or off, and particles move on their own canvas field", () => {
  assert.equal(normalizeMotion("full"), "subtle");
  assert.equal(normalizeMotion("dark"), "subtle");
  assert.equal(normalizeMotion("off"), "off");
  assert.equal(normalizeMotion(undefined), "subtle");

  const halloween = createField("halloween", 2);
  assert.equal(halloween.particles.length, 24);
  assert.ok(halloween.particles.some((particle) => particle.kind === "pumpkin"));
  assert.ok(halloween.particles.some((particle) => particle.kind === "spider"));
  assert.ok(halloween.particles.some((particle) => particle.kind === "candy"));
  assert.ok(halloween.particles.some((particle) => particle.kind === "bat"));
  const before = halloween.particles[0].y;
  stepField(halloween, 0.5);
  assert.notEqual(halloween.particles[0].y, before);

  const christmas = createField("christmas", 2);
  assert.ok(christmas.particles.some((particle) => particle.kind === "snow"));
  assert.ok(christmas.particles.some((particle) => particle.kind === "ornament"));
  assert.ok(christmas.particles.length <= 48);

  const plain = createField("pinnacle", 2);
  assert.ok(plain.particles.length <= 12);
  assert.ok(plain.particles.every((particle) => particle.kind === "mote"));
});
