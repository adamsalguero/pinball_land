const STALL_NUDGE_MS = 2000;

function blobWatchdog({ quietMs = 0, paused = false, ended = false, nudged = false } = {}) {
  if (ended) return "ended";
  if (paused) return "wait";
  if ((Number(quietMs) || 0) < STALL_NUDGE_MS) return "wait";
  if (!nudged) return "nudge";
  return "next";
}

const playbackApi = { STALL_NUDGE_MS, blobWatchdog };

if (typeof module !== "undefined" && module.exports) module.exports = playbackApi;
if (typeof window !== "undefined") window.PinballPlayback = playbackApi;
