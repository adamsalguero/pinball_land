const fs = require("fs");
const path = require("path");

// Original short loops made for the wall. They are public domain and play
// offline from the app folder. Holiday streams stay optional extras.
const BUNDLED_CLIPS = [
  { id: "arcade-lights", title: "Arcade lights", file: "arcade-lights.mp4", durationSec: 6 },
  { id: "neon-sweep", title: "Neon sweep", file: "neon-sweep.mp4", durationSec: 6 },
  { id: "marquee", title: "Marquee", file: "marquee.mp4", durationSec: 6 },
];

function bundledDir(appRoot) {
  return path.join(appRoot || path.join(__dirname, ".."), "media", "bundled");
}

function bundledCards(appRoot) {
  const dir = bundledDir(appRoot);
  return BUNDLED_CLIPS.filter((clip) => fs.existsSync(path.join(dir, clip.file))).map((clip) => ({
    type: "video",
    id: `bundled:${clip.id}`,
    url: `/media/bundled/${clip.file}`,
    title: clip.title,
    loop: true,
    mode: "card",
    local: true,
    stream: false,
    durationSec: clip.durationSec,
  }));
}

function bundledFile(appRoot, name) {
  const file = path.basename(String(name || ""));
  if (!/^[\w.-]+\.mp4$/i.test(file)) return null;
  if (!BUNDLED_CLIPS.some((clip) => clip.file === file)) return null;
  const full = path.join(bundledDir(appRoot), file);
  if (!fs.existsSync(full)) return null;
  return full;
}

module.exports = { BUNDLED_CLIPS, bundledDir, bundledCards, bundledFile };
