const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { prepareLogoSvg } = require("../src/logo-color");

function channel(hex, shift) {
  const value = (parseInt(hex.slice(1), 16) >> shift) & 255;
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function contrast(fg, bg) {
  const luminance = (hex) => 0.2126 * channel(hex, 16) + 0.7152 * channel(hex, 8) + 0.0722 * channel(hex, 0);
  const hi = Math.max(luminance(fg), luminance(bg));
  const lo = Math.min(luminance(fg), luminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

test("served logos drop the plate and stay readable on a dark ground", () => {
  const pinnacle = prepareLogoSvg(fs.readFileSync(path.join(__dirname, "..", "public", "logos", "pinnacle.svg"), "utf8"));
  assert.doesNotMatch(pinnacle, /<rect\b/i);
  assert.match(pinnacle, /#F4EFE4/);
  assert.match(pinnacle, /#81338B/);
  assert.doesNotMatch(pinnacle, /#504E50/);
  assert.doesNotMatch(pinnacle, /#62006E/);
  assert.match(pinnacle, /Pinnacle Group Financial Services/);
  const subtitle = pinnacle.match(/id="subtitle"[^>]*>\s*<path\b[^>]*fill="(#[0-9A-Fa-f]{6})"/);
  assert.equal(subtitle[1].toUpperCase(), "#C79BD0");
  assert.ok(contrast(subtitle[1], "#1a1916") >= 4.5);
  assert.ok(contrast(subtitle[1], "#241c26") >= 4.5);

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
