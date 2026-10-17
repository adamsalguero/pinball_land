const SLOT_IDS = ["1", "2", "3"];
const DISPLAY_CONTENTS = ["rotation", "logos", "amenities", "leaderboard", "pinboard", "video", "clock"];
const BLACK_DISPLAY = new Set(["off", "black", "dark"]);
const LEGACY_DISPLAY = {
  pinnacle: "logos",
  "pinball-land": "logos",
  "amenity-arcade": "amenities",
  "amenity-oasis": "amenities",
  "amenity-events": "amenities",
  photos: "pinboard",
  collage: "pinboard",
};

function canonicalDisplayContent(content) {
  const value = String(content || "");
  if (BLACK_DISPLAY.has(value)) return "rotation";
  const mapped = LEGACY_DISPLAY[value] || value;
  return DISPLAY_CONTENTS.includes(mapped) ? mapped : null;
}

function clampCount(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(3, Math.max(1, n));
}

function normalizeScreen(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const content = canonicalDisplayContent(incoming.content) || "rotation";
  const leaderboardId = incoming.leaderboardId ? String(incoming.leaderboardId) : null;
  return {
    enabled: incoming.enabled !== false,
    content,
    leaderboardId,
  };
}

function normalizeDisplays(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const screensIn = incoming.screens && typeof incoming.screens === "object" ? incoming.screens : {};
  const screens = {};
  for (const slot of SLOT_IDS) {
    screens[slot] = normalizeScreen(screensIn[slot]);
  }
  const order = Array.isArray(incoming.order)
    ? [...new Set(incoming.order.map((id) => String(id)).filter(Boolean))].slice(0, 8)
    : [];
  return {
    count: clampCount(incoming.count ?? incoming.activeCount ?? 3),
    mirror: Boolean(incoming.mirror),
    order,
    screens,
  };
}

const DEFAULT_DISPLAYS = normalizeDisplays({});

function sortDisplays(displays) {
  return [...(displays || [])].sort((a, b) => {
    const ax = a.bounds?.x ?? 0;
    const bx = b.bounds?.x ?? 0;
    if (ax !== bx) return ax - bx;
    return (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0);
  });
}

function applyOrder(sorted, order) {
  if (!order?.length) return sorted;
  const byId = new Map(sorted.map((display) => [String(display.id), display]));
  const arranged = [];
  const used = new Set();
  for (const id of order) {
    const display = byId.get(String(id));
    if (!display || used.has(String(display.id))) continue;
    arranged.push(display);
    used.add(String(display.id));
  }
  for (const display of sorted) {
    if (!used.has(String(display.id))) arranged.push(display);
  }
  return arranged;
}

function mapDisplaysToSlots(displays, options = {}) {
  const config = normalizeDisplays(options.displays || options);
  const arranged = applyOrder(sortDisplays(displays), config.order);
  const physical = arranged.slice(0, config.count);
  const windows = [];
  const skipped = [];
  for (let i = 0; i < config.count; i += 1) {
    const slot = i + 1;
    const screen = config.screens[String(slot)];
    if (!screen.enabled) continue;
    const display = physical[i];
    if (!display) {
      skipped.push(slot);
      continue;
    }
    windows.push({
      slot,
      bounds: display.bounds,
      id: display.id,
    });
  }
  return { windows, skipped, count: config.count, arranged };
}

function layoutForDisplays(input) {
  const config = normalizeDisplays(input);
  const layout = {};
  for (const slot of SLOT_IDS) {
    const own = config.screens[slot];
    const source = config.mirror ? config.screens["1"] : own;
    layout[slot] = {
      enabled: Number(slot) <= config.count && own.enabled,
      content: source.content,
      leaderboardId: source.leaderboardId,
      mirror: config.mirror,
      staggerIndex: config.mirror ? 0 : Number(slot) - 1,
    };
  }
  return layout;
}

function windowLayoutKey(displaysConfig, restartToken = 0) {
  const config = normalizeDisplays(displaysConfig);
  return JSON.stringify({
    count: config.count,
    order: config.order,
    enabled: SLOT_IDS.map((slot) => config.screens[slot].enabled),
    restartToken: Number(restartToken) || 0,
  });
}

function slotLabel(slot, count) {
  const n = Number(slot);
  const total = clampCount(count);
  if (total <= 1) return "Screen";
  if (total === 2) return n === 1 ? "Left" : "Right";
  return ["", "Left", "Center", "Right"][n] || `Screen ${n}`;
}

module.exports = {
  SLOT_IDS,
  DISPLAY_CONTENTS,
  canonicalDisplayContent,
  DEFAULT_DISPLAYS,
  clampCount,
  normalizeDisplays,
  sortDisplays,
  applyOrder,
  mapDisplaysToSlots,
  layoutForDisplays,
  windowLayoutKey,
  slotLabel,
};
