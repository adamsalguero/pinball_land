const MONITOR_WAIT_MS = 120000;

function expectedMonitorCount(displays) {
  const count = Math.min(3, Math.max(0, Number(displays?.count) || 0));
  let enabled = 0;
  for (let slot = 1; slot <= count; slot += 1) {
    if (displays?.screens?.[String(slot)]?.enabled !== false) enabled += 1;
  }
  return enabled;
}

function monitorSignature(list) {
  return (Array.isArray(list) ? list : [])
    .map((display) => {
      const bounds = display?.bounds || {};
      return `${display?.id}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
    })
    .sort()
    .join("|");
}

function signatureCount(signature) {
  if (!signature) return 0;
  return String(signature).split("|").filter(Boolean).length;
}

// Wait once for late TVs. Open the slots that already have a monitor, and do not
// close them on the next poll. After the wait, a new monitor opens only the slot
// that was missing. A short monitor count is never a reason to reopen the wall.
function placementDecision({
  seen = 0,
  expected = 0,
  signature = "",
  previousSignature = "",
  openSlots = [],
  wantedSlots = [],
  crashed = [],
  unresponsive = [],
  elapsedMs = 0,
  timeoutMs = MONITOR_WAIT_MS,
  settled = false,
  openedOnce = false,
} = {}) {
  const ready = expected > 0 && seen >= expected;
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const timeout = Math.max(0, Number(timeoutMs) || MONITOR_WAIT_MS);
  const timedOut = !ready && elapsed >= timeout;
  const waiting = !ready && !settled && !timedOut;
  const reload = [...new Set([...(crashed || []), ...(unresponsive || [])].map(String))];
  const open = new Set((openSlots || []).map((slot) => String(slot)));
  const missing = (wantedSlots || []).filter((slot) => !open.has(String(slot)));
  const previousCount = signatureCount(previousSignature);
  const firstLook = !openedOnce;
  const monitorAdded = openedOnce && seen > previousCount;
  let openMissing = [];
  if (firstLook || monitorAdded) openMissing = missing;
  return {
    ready,
    waiting,
    settle: ready || settled || timedOut,
    reopen: false,
    openMissing,
    reload,
  };
}

function retryDelay(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(30000, 1000 * 2 ** Math.min(n, 5));
}

module.exports = {
  MONITOR_WAIT_MS,
  expectedMonitorCount,
  monitorSignature,
  placementDecision,
  retryDelay,
};
