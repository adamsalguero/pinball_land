const STALL_STRIKE_LIMIT = 3;
const STALL_STRIKE_EVENTS = new Set(["stall-timeout", "give-up"]);

const WALL_CHROME_FLAGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

const SOFTWARE_DECODE_FLAGS = [
  "--disable-gpu-video-decode",
  "--disable-accelerated-video-decode",
];

function noteStall(count, event) {
  const current = Number(count) || 0;
  if (!STALL_STRIKE_EVENTS.has(String(event || ""))) return { count: current, enable: false };
  const next = current + 1;
  return { count: next, enable: next >= STALL_STRIKE_LIMIT };
}

module.exports = {
  STALL_STRIKE_LIMIT,
  STALL_STRIKE_EVENTS,
  WALL_CHROME_FLAGS,
  SOFTWARE_DECODE_FLAGS,
  noteStall,
};
