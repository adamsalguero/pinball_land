const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { blobWatchdog, STALL_NUDGE_MS } = require("../public/playback");

test("a frozen picture seeks forward once, then moves to the next clip", () => {
  assert.equal(STALL_NUDGE_MS, 2000);
  assert.equal(blobWatchdog({ quietMs: 1000, paused: false }), "wait");
  assert.equal(blobWatchdog({ quietMs: 2000, paused: true }), "wait");
  assert.equal(blobWatchdog({ quietMs: 2000, ended: true }), "ended");
  assert.equal(blobWatchdog({ quietMs: 2000, paused: false, nudged: false }), "nudge");
  assert.equal(blobWatchdog({ quietMs: 2000, paused: false, nudged: true }), "next");
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

test("the wall player uses one blob per screen and does not nudge a waiting element", () => {
  const display = fs.readFileSync(path.join(__dirname, "..", "public", "display.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "display.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "display.css"), "utf8");
  const control = fs.readFileSync(path.join(__dirname, "..", "public", "control.html"), "utf8");
  assert.doesNotMatch(display, /logoPhaseKey/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "src", "playlist.js"), "utf8"), /logoPhaseKey/);
  assert.match(display, /preloadUpcoming/);
  assert.match(display, /blobWatchdog/);
  assert.match(display, /seekPastStall/);
  assert.match(display, /now \+ 0\.5/);
  assert.match(display, /earlierSlotHasClip/);
  assert.match(display, /createObjectURL/);
  assert.match(display, /blob-loaded/);
  assert.match(display, /play-start/);
  assert.match(display, /event === "progress"/);
  assert.doesNotMatch(display, /visibilitychange/);
  assert.doesNotMatch(display, /nudgePlayback/);
  assert.doesNotMatch(display, /currentTime = time \+ 0\.04/);
  assert.doesNotMatch(display, /is-leaving/);
  assert.match(display, /wallVideo\.remove\(\)/);
  assert.match(display, /preload = "none"/);
  assert.match(display, /preload = "auto"/);
  assert.doesNotMatch(display, /preload = "metadata"/);
  assert.match(display, /releaseVideoElement/);
  assert.match(display, /replaceWallVideo/);
  assert.match(display, /type: "media-failure"/);
  assert.match(display, /type: "media-next"/);
  assert.match(display, /getVideoPlaybackQuality/);
  assert.match(display, /WEBGL_debug_renderer_info/);
  assert.match(display, /nextRotationPlan/);
  assert.match(display, /thisSlotMayPlay/);
  assert.doesNotMatch(display, /function replayBlob/);
  assert.doesNotMatch(display, /\/api\/media\/failure/);
  assert.doesNotMatch(display, /\/api\/media\/next/);
  assert.match(control, /id="tvs-toggle"/);
  assert.doesNotMatch(control, /Allow admin from internet/);
  assert.doesNotMatch(control, /id="motion-toggle"/);
  assert.doesNotMatch(control, /id="join-qr"/);
  assert.match(display, /function serverTick/);
  assert.match(display, /stageWallVideo/);
  assert.match(display, /holdFrame/);
  assert.doesNotMatch(html, /<video/i);
  assert.match(display, /themeAllowsVideo/);
  assert.match(display, /src = ""/);
  assert.match(display, /querySelectorAll\("video"\)/);
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
  assert.match(kiosk, /displayUrl/);
  assert.match(kiosk, /discoverDisplayOrigins/);
  assert.match(launcher, /localhost/);
  assert.match(launcher, /127\.0\.0\.1/);
  assert.match(launcher, /\[::1\]/);
  assert.match(doc, /http:\/\/localhost:3000\/display\/1/);
  assert.match(doc, /http:\/\/127\.0\.0\.1:3000\/display\/2/);
  assert.match(doc, /http:\/\/\[::1\]:3000\/display\/3/);
  assert.match(kiosk, /disable-gpu-video-decode/);
  assert.match(kiosk, /disable-accelerated-video-decode/);
  assert.match(kiosk, /softwareDecode/);
  assert.match(launcher, /softwareVideoDecode/);
  assert.match(launcher, /disable-gpu-video-decode/);
  assert.match(launcher, /disable-accelerated-video-decode/);
  assert.match(doc, /disable-gpu-video-decode/);
  assert.match(doc, /disable-accelerated-video-decode/);
  const control = fs.readFileSync(path.join(__dirname, "..", "public", "control.js"), "utf8");
  const wall = fs.readFileSync(path.join(__dirname, "..", "public", "display.js"), "utf8");
  assert.match(control, /decor-toggle/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "public", "control.html"), "utf8"), /id="decor-toggle"/);
  assert.doesNotMatch(control, /label: "Video"/);
  assert.match(control, /function themeClipChoices/);
  assert.match(control, /button\.textContent = item\.title/);
  assert.match(control, /clipId: item\.id/);
  assert.match(wall, /function themeAllowsVideo\(\) \{\n  const theme = activeTheme\(\);\n  return theme === "halloween" \|\| theme === "christmas";\n\}/);
  const guest = fs.readFileSync(path.join(__dirname, "..", "public", "guest.js"), "utf8");
  assert.match(guest, /navigator\.share/);
  assert.match(control, /navigator\.share/);
  assert.match(control, /Could not download the photos\./);
  assert.doesNotMatch(guest, /window\.location/);
  assert.doesNotMatch(control, /window\.location\s*=/);
  assert.doesNotMatch(control, /href = "\/api\/guest-photos\/zip"/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "public", "display.html"), "utf8"), /Be the first/);
  assert.match(wall, /function decorationsPaused\(\) \{\n  return Boolean\(SHOT \|\| document\.documentElement\.dataset\.motion === "reduced"\);\n\}/);
  assert.match(control, /label: "Auto"/);
  assert.match(control, /Show photo on wall/);
  assert.match(control, /Remove photo/);
  assert.match(control, /Approve, keep photo private \(verification only\)/);
});
