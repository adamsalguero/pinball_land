const { includeInRotation } = require("./media");

const DEFAULT_INTERVAL_SEC = 25;
const LEGACY_INTERVAL_SEC = 14;
const AMENITY_DWELL_SEC = 12;
const AMENITY_ORDER = ["arcade", "oasis", "events"];
const LOGO_ORDER = ["pinnacle", "pinball-land"];

const ROTATION_ITEM_IDS = [
  "logoPinnacle",
  "logoEntertainment",
  "amenities",
  "clock",
  "pinboard",
];

const DEFAULT_ROTATION_ITEMS = Object.fromEntries(ROTATION_ITEM_IDS.map((id) => [id, true]));

function clampInterval(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_SEC;
  return Math.min(120, Math.max(10, n));
}

function migrateInterval(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_INTERVAL_SEC;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n === LEGACY_INTERVAL_SEC) return DEFAULT_INTERVAL_SEC;
  return clampInterval(n);
}

function normalizeRotation(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const items = { ...DEFAULT_ROTATION_ITEMS };
  const saved = incoming.items && typeof incoming.items === "object" ? incoming.items : null;
  if (saved) {
    for (const id of ROTATION_ITEM_IDS) {
      if (typeof saved[id] === "boolean") items[id] = saved[id];
    }
    if (typeof saved.amenities !== "boolean") {
      const legacy = ["amenityArcade", "amenityOasis", "amenityEvents"].filter((id) => typeof saved[id] === "boolean");
      if (legacy.length) items.amenities = legacy.some((id) => saved[id]);
    }
  }
  const startedAt = Number(incoming.startedAt);
  return {
    enabled: incoming.enabled !== false,
    intervalSec: migrateInterval(incoming.intervalSec),
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    items,
  };
}

function buildPlaylist(state, options = {}) {
  const cards = [];
  const items = state?.rotation?.items || DEFAULT_ROTATION_ITEMS;
  if (items.logoPinnacle) {
    cards.push({ type: "logo", key: "pinnacle", label: "Pinnacle Group Financial Services" });
  }
  if (items.logoEntertainment) {
    cards.push({ type: "logo", key: "pinball-land", label: "Pinnacle Entertainment Center" });
  }
  if (items.amenities) {
    cards.push({ type: "amenity", id: "amenities", cycle: true });
  }
  if (items.clock) {
    cards.push({ type: "clock", id: "clock" });
  }
  if (items.pinboard) {
    cards.push({
      type: options.photoStyle === "collage" ? "collage" : "pinboard",
      id: "pinboard",
      span: options.photoSpan !== false,
    });
  }
  for (const board of state?.leaderboards || []) {
    if (board.inRotation) {
      cards.push({ type: "leaderboard", id: board.id });
    }
  }
  const starters = Array.isArray(options.starters) ? options.starters : [];
  for (const starter of starters) cards.push(starter);
  const youtube = Array.isArray(options.youtube) ? options.youtube : [];
  for (const item of youtube) {
    cards.push({ type: "youtube", id: item.id, kind: item.kind, title: item.title });
  }
  const videos = Array.isArray(options.videos) ? options.videos : [];
  for (const video of videos) {
    if (!includeInRotation(video, { theme: state?.theme, allAges: options.allAges !== false })) continue;
    cards.push({
      type: "video",
      id: video.id,
      url: video.url,
      title: video.title,
      loop: video.loop !== false,
      mode: "card",
    });
  }
  return cards;
}

function currentTick(startedAt, intervalSec, now = Date.now()) {
  const ms = clampInterval(intervalSec) * 1000;
  const start = Number(startedAt);
  const origin = Number.isFinite(start) ? start : now;
  return Math.floor(Math.max(0, now - origin) / ms);
}

function tickForSlot(startedAt, intervalSec, slotIndex, screenCount = 3, now = Date.now()) {
  const ms = clampInterval(intervalSec) * 1000;
  const screens = Math.max(1, Number(screenCount) || 1);
  const slot = Math.max(0, Number(slotIndex) || 0) % screens;
  const offset = slot * (ms / screens);
  const start = Number(startedAt);
  const origin = Number.isFinite(start) ? start : now;
  return Math.floor(Math.max(0, now - origin - offset) / ms);
}

function cycleIndex(startedAt, dwellSec, length, slotIndex = 0, now = Date.now()) {
  const count = Math.max(1, Number(length) || 1);
  const dwell = Math.max(1, Number(dwellSec) || 1) * 1000;
  const slot = Math.max(0, Number(slotIndex) || 0);
  const offset = (slot % count) * (dwell / count);
  const start = Number(startedAt);
  const origin = Number.isFinite(start) ? start : now;
  const elapsed = Math.max(0, now - origin - offset);
  return Math.floor(elapsed / dwell) % count;
}

function amenityAt(startedAt, slotIndex = 0, now = Date.now()) {
  return AMENITY_ORDER[cycleIndex(startedAt, AMENITY_DWELL_SEC, AMENITY_ORDER.length, slotIndex, now)];
}

function logoAt(startedAt, slotIndex = 0, now = Date.now()) {
  return LOGO_ORDER[cycleIndex(startedAt, AMENITY_DWELL_SEC, LOGO_ORDER.length, slotIndex, now)];
}

function slotIndexForDisplay(slotId) {
  const n = Number.parseInt(slotId, 10);
  return Number.isFinite(n) && n > 0 ? n - 1 : 0;
}

function cardForSlot(playlist, tick, slotIndex) {
  if (!Array.isArray(playlist) || playlist.length === 0) {
    return null;
  }
  const n = playlist.length;
  const index = (((Number(tick) || 0) + (Number(slotIndex) || 0)) % n + n) % n;
  return playlist[index];
}

module.exports = {
  DEFAULT_INTERVAL_SEC,
  LEGACY_INTERVAL_SEC,
  AMENITY_DWELL_SEC,
  AMENITY_ORDER,
  LOGO_ORDER,
  ROTATION_ITEM_IDS,
  DEFAULT_ROTATION_ITEMS,
  clampInterval,
  migrateInterval,
  normalizeRotation,
  buildPlaylist,
  currentTick,
  tickForSlot,
  cycleIndex,
  amenityAt,
  logoAt,
  slotIndexForDisplay,
  cardForSlot,
};
