const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("entertainment logo is outlined paths on a transparent ground", () => {
  const svg = fs.readFileSync(path.join(__dirname, "..", "public", "logos", "pinball-land.svg"), "utf8");
  assert.equal(svg.includes("<text"), false);
  assert.equal(svg.includes("font-family"), false);
  assert.match(svg, /#62006E/);
  assert.match(svg, /#504E50/);
  assert.match(svg, /#a269a9/);
  assert.match(svg, /#2d4c32/);
  assert.doesNotMatch(svg, /#e8e4dc/i);
  assert.doesNotMatch(svg, /fill="#e5e2da"/i);
  const mark = fs.readFileSync(path.join(__dirname, "..", "public", "icons", "mark.svg"), "utf8");
  assert.match(mark, /#62006E/);
  assert.equal(mark.includes("<text"), false);
});
