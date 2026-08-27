const DEFAULT_INTERVAL_SEC = 14;

const ROTATION_ITEM_IDS = [
  "logoPinnacle",
  "logoEntertainment",
  "amenityArcade",
  "amenityOasis",
  "amenityEvents",
];

const DEFAULT_ROTATION_ITEMS = Object.fromEntries(ROTATION_ITEM_IDS.map((id) => [id, true]));

function clampInterval(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_SEC;
  return Math.min(180, Math.max(3, n));
}

function normalizeRotation(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const items = { ...DEFAULT_ROTATION_ITEMS };
  if (incoming.items && typeof incoming.items === "object") {
    for (const id of ROTATION_ITEM_IDS) {
      if (typeof incoming.items[id] === "boolean") {
        items[id] = incoming.items[id];
      }
    }
  }
  const startedAt = Number(incoming.startedAt);
  return {
    enabled: incoming.enabled !== false,
    intervalSec: clampInterval(incoming.intervalSec ?? DEFAULT_INTERVAL_SEC),
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    items,
  };
}

function buildPlaylist(state) {
  const cards = [];
  const items = state?.rotation?.items || DEFAULT_ROTATION_ITEMS;
  if (items.logoPinnacle) {
    cards.push({ type: "logo", key: "pinnacle", label: "Pinnacle Group Financial Services" });
  }
  if (items.logoEntertainment) {
    cards.push({ type: "logo", key: "pinball-land", label: "Pinnacle Entertainment Center" });
  }
  if (items.amenityArcade) {
    cards.push({ type: "amenity", id: "arcade" });
  }
  if (items.amenityOasis) {
    cards.push({ type: "amenity", id: "oasis" });
  }
  if (items.amenityEvents) {
    cards.push({ type: "amenity", id: "events" });
  }
  for (const board of state?.leaderboards || []) {
    if (board.inRotation) {
      cards.push({ type: "leaderboard", id: board.id });
    }
  }
  return cards;
}

function currentTick(startedAt, intervalSec, now = Date.now()) {
  const ms = Math.max(1, clampInterval(intervalSec)) * 1000;
  const start = Number(startedAt);
  const origin = Number.isFinite(start) ? start : now;
  return Math.floor(Math.max(0, now - origin) / ms);
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
  ROTATION_ITEM_IDS,
  DEFAULT_ROTATION_ITEMS,
  clampInterval,
  normalizeRotation,
  buildPlaylist,
  currentTick,
  slotIndexForDisplay,
  cardForSlot,
};
