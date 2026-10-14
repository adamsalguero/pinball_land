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

function placementDecision({
  seen = 0,
  expected = 0,
  signature = "",
  previousSignature = "",
  windowCount = 0,
  crashed = [],
  unresponsive = [],
} = {}) {
  const ready = expected > 0 && seen >= expected;
  const changed = signature !== previousSignature;
  const short = windowCount < Math.min(seen, expected);
  const reload = [...new Set([...(crashed || []), ...(unresponsive || [])].map(String))];
  return {
    ready,
    waiting: !ready,
    reopen: !ready || changed || short || reload.length > 0,
    reload,
  };
}

function retryDelay(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(30000, 1000 * 2 ** Math.min(n, 5));
}

module.exports = {
  expectedMonitorCount,
  monitorSignature,
  placementDecision,
  retryDelay,
};
