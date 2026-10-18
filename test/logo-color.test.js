const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { prepareLogoSvg } = require("../src/logo-color");

test("served logos drop the plate and stay readable on a dark ground", () => {
  const pinnacle = prepareLogoSvg(fs.readFileSync(path.join(__dirname, "..", "public", "logos", "pinnacle.svg"), "utf8"));
  assert.doesNotMatch(pinnacle, /<rect\b/i);
  assert.match(pinnacle, /#F4EFE4/);
  assert.match(pinnacle, /#81338B/);
  assert.doesNotMatch(pinnacle, /#504E50/);
  assert.doesNotMatch(pinnacle, /#62006E/);
  assert.match(pinnacle, /Pinnacle Group Financial Services/);

  const entertainment = prepareLogoSvg(fs.readFileSync(path.join(__dirname, "..", "public", "logos", "pinball-land.svg"), "utf8"));
  assert.doesNotMatch(entertainment, /<rect\b/i);
  assert.match(entertainment, /id="charcoal-word"[^>]*fill="#F4EFE4"/);
  assert.match(entertainment, /id="charcoal-frame"[^>]*fill="#D9D4CC"/);
  assert.match(entertainment, /id="charcoal"[^>]*fill="#504E50"/);
  assert.match(entertainment, /id="charcoal-dots"[^>]*fill="#FFFFFF"/);
  assert.match(entertainment, /#81338B/);
  assert.doesNotMatch(entertainment, /#62006E/);
  assert.doesNotMatch(entertainment, /#e8e4dc/i);
});
