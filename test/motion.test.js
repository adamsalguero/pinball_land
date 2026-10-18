const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createField, stepField } = require("../public/motion");
const { normalizeMotion } = require("../src/config");

test("transitions are subtle or off, and particles move on their own canvas field", () => {
  assert.equal(normalizeMotion("full"), "subtle");
  assert.equal(normalizeMotion("dark"), "subtle");
  assert.equal(normalizeMotion("off"), "subtle");
  assert.equal(normalizeMotion(undefined), "subtle");

  const { worldPoint, screenPoint, spiderSilk, WORLD_W, SLICE_W } = require("../public/motion");
  const halloween = createField("halloween", 2);
  assert.equal(halloween.particles.length, 16);
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

test("spider legs fan out and the outer segment bends gently down", () => {
  const { drawSpider, strokeSpiderSilk } = require("../public/motion");
  const size = 80;
  const legs = [];
  const ctx = {
    beginPath() {},
    moveTo(x, y) { this.hip = { x, y }; },
    quadraticCurveTo(x, y, footX, footY) {
      legs.push({ hip: this.hip, knee: { x, y }, foot: { x: footX, y: footY } });
    },
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
  };
  drawSpider(ctx, size, 0);
  assert.equal(ctx.lineCap, "round");
  assert.equal(ctx.lineJoin, "round");
  assert.equal(legs.length, 8);
  const body = size * 0.22;
  const diameter = body * 2;
  for (const side of [-1, 1]) {
    const group = legs.filter((leg) => Math.sign(leg.foot.x) === side)
      .sort((a, b) => a.foot.y - b.foot.y);
    assert.equal(group.length, 4);
    const angles = group.map((leg) => Math.atan2(leg.foot.y - leg.hip.y, side * (leg.foot.x - leg.hip.x)));
    assert.ok(group[0].knee.y < group[0].hip.y - body * 0.4, "front leg arches up");
    assert.ok(group[0].foot.y > group[0].knee.y + body * 0.4, "front tip drops from that arch");
    assert.ok(Math.abs(angles[1]) < 0.35, "upper middle stays near horizontal");
    assert.ok(angles[2] > 0.15, "lower middle angles down");
    assert.ok(angles[3] > angles[2] + 0.2, "back leg is steeper");
    assert.ok(group[0].knee.y < group[1].knee.y - body * 0.5, "front arch is above the middle legs");
    assert.ok(group[3].foot.y > group[2].foot.y + body * 0.3, "back foot hangs below the leg above it");
    for (const leg of group) {
      const midY = (leg.hip.y + leg.foot.y) / 2;
      assert.ok(leg.knee.y < midY, "one gentle upward bow before the tip");
      assert.ok(leg.foot.y > leg.knee.y, "outer segment bends down toward the tip");
      assert.ok(side * (leg.foot.x - leg.hip.x) > body * 0.25, "every leg still reaches outward");
    }
    const level = group[1];
    const sideways = Math.abs(level.foot.x) - body;
    assert.ok(sideways > diameter * 0.4 && sideways < diameter * 0.7);
  }

  const silk = { line: null };
  const silkCtx = {
    save() {},
    restore() {},
    beginPath() { this.pts = []; },
    moveTo(x, y) { this.pts.push({ x, y }); },
    lineTo(x, y) { this.pts.push({ x, y }); },
    stroke() { silk.line = this.pts; },
  };
  strokeSpiderSilk(silkCtx, { x: 140, y: 260 }, size);
  assert.equal(silk.line[0].y, 0);
  assert.equal(silk.line[0].x, 140);
  assert.equal(silk.line[1].x, 140);
  assert.ok(Math.abs(silk.line[1].y - (260 - body * 1.2)) < 0.01);
});
