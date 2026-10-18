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

// Two give-ups in a row replace the element. A third, still stuck, reloads the page.
function poolRecovery(consecutiveGiveUps) {
  const count = Number(consecutiveGiveUps) || 0;
  if (count >= 3) return "reload";
  if (count >= 2) return "reset";
  return "swap";
}

const playbackApi = { STALL_NUDGE_MS, STALL_SKIP_MS, stallAction, poolRecovery };

if (typeof module !== "undefined" && module.exports) module.exports = playbackApi;
if (typeof window !== "undefined") window.PinballPlayback = playbackApi;
