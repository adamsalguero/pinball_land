const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { stallAction, STALL_SKIP_MS } = require("../public/playback");

test("waiting and suspend are not a skip, and a stall waits 20s while visible", () => {
  assert.equal(STALL_SKIP_MS, 20000);
  assert.equal(stallAction({ quietMs: 3000, visible: true, paused: false }), "wait");
  assert.equal(stallAction({ quietMs: 6000, visible: true, nudged: false }), "nudge");
  assert.equal(stallAction({ quietMs: 12000, visible: true, nudged: true }), "wait");
  assert.equal(stallAction({ quietMs: 20000, visible: true, nudged: true }), "skip");
  assert.equal(stallAction({ quietMs: 60000, visible: false, nudged: true }), "hold");
  assert.equal(stallAction({ quietMs: 1000, visible: true, paused: true }), "play");
  assert.equal(stallAction({ quietMs: 20000, visible: true, paused: true, nudged: true }), "skip");
  assert.equal(stallAction({ ended: true, quietMs: 30000 }), "ended");
});

test("wall scripts do not reuse the same top-level name", () => {
  const root = path.join(__dirname, "..", "public");
  const files = ["motion.js", "rotation.js", "playback.js", "display.js"];
  const bindings = new Map();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const names = [...source.matchAll(/^(?:async\s+)?(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
    bindings.set(file, names);
  }
  const seen = new Map();
  for (const [file, names] of bindings) {
    for (const name of names) {
      if (seen.has(name)) throw new Error(`${name} is declared in ${seen.get(name)} and ${file}`);
      seen.set(name, file);
    }
  }
});

test("the wall player resumes occluded video and only one element stays loaded", () => {
  const display = fs.readFileSync(path.join(__dirname, "..", "public", "display.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "display.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "display.css"), "utf8");
  assert.match(display, /visibilitychange/);
  assert.match(display, /resumePlayback/);
  assert.doesNotMatch(display, /logoPhaseKey/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "src", "playlist.js"), "utf8"), /logoPhaseKey/);
  assert.match(display, /preloadUpcoming/);
  assert.match(display, /stallAction/);
  assert.doesNotMatch(display, /is-leaving/);
  assert.match(display, /wallVideo\.remove\(\)/);
  assert.match(display, /preload = "none"/);
  assert.match(display, /function serverTick/);
  assert.match(display, /stageWallVideo/);
  assert.match(display, /holdFrame/);
  assert.match(html, /preload="none"/);
  assert.match(html, /id="video-hold"/);
  assert.match(css, /is-staging/);
  assert.match(css, /is-fading-out/);
  assert.match(css, /wall-cross/);
});

test("kiosk and the home Chrome launcher disable window occlusion", () => {
  const kiosk = fs.readFileSync(path.join(__dirname, "..", "src", "kiosk.js"), "utf8");
  const doc = fs.readFileSync(path.join(__dirname, "..", "KIOSK.md"), "utf8");
  const launcher = fs.readFileSync(path.join(__dirname, "..", "scripts", "open-wall-chrome.ps1"), "utf8");
  for (const source of [kiosk, doc, launcher]) {
    assert.match(source, /disable-backgrounding-occluded-windows/);
    assert.match(source, /disable-renderer-backgrounding/);
    assert.match(source, /disable-background-timer-throttling/);
    assert.match(source, /CalculateNativeWinOcclusion/);
    assert.match(source, /BackgroundMediaSuspend/);
    assert.match(source, /disable-background-media-suspend/);
    assert.match(source, /IntensiveWakeUpThrottling/);
  }
  assert.match(kiosk, /backgroundThrottling: false/);
  const control = fs.readFileSync(path.join(__dirname, "..", "public", "control.js"), "utf8");
  assert.match(control, /Show photo on wall/);
  assert.match(control, /Remove photo/);
  assert.match(control, /Approve, keep photo private \(verification only\)/);
});
