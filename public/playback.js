const STALL_SKIP_MS = 20000;

// A frozen picture (playing, not paused) replays the same blob once, then the next clip.
function blobWatchdog({ quietMs = 0, paused = false, ended = false, failures = 0 } = {}) {
  if (ended) return "ended";
  if (paused) return "wait";
  if ((Number(quietMs) || 0) < STALL_SKIP_MS) return "wait";
  if ((Number(failures) || 0) >= 1) return "next";
  return "replay";
}

const playbackApi = { STALL_SKIP_MS, blobWatchdog };

if (typeof module !== "undefined" && module.exports) module.exports = playbackApi;
if (typeof window !== "undefined") window.PinballPlayback = playbackApi;
