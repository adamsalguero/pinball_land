const STALL_NUDGE_MS = 5000;
const STALL_SKIP_MS = 20000;

// waiting/suspend are normal. Nudge, then skip only after 20s without progress while visible.
function stallAction({ quietMs = 0, visible = true, nudged = false, paused = false, ended = false } = {}) {
  if (ended) return "ended";
  if (!visible) return "hold";
  const quiet = Number(quietMs) || 0;
  if (nudged && quiet >= STALL_SKIP_MS) return "skip";
  if (!nudged && quiet >= STALL_NUDGE_MS) return "nudge";
  if (paused) return "play";
  return "wait";
}

const playbackApi = { STALL_NUDGE_MS, STALL_SKIP_MS, stallAction };

if (typeof module !== "undefined" && module.exports) module.exports = playbackApi;
if (typeof window !== "undefined") window.PinballPlayback = playbackApi;
