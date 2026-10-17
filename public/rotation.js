function clampInterval(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(120, Math.max(10, n));
}

function currentTick(startedAt, intervalSec, now = Date.now()) {
  const ms = clampInterval(intervalSec) * 1000;
  const start = Number(startedAt);
  const origin = Number.isFinite(start) ? start : now;
  return Math.floor(Math.max(0, now - origin) / ms);
}

// Every screen shares one dwell clock. Slot index only picks a different card.
function tickForSlot(startedAt, intervalSec, _slotIndex, _screenCount, now = Date.now()) {
  return currentTick(startedAt, intervalSec, now);
}

function cardForSlot(playlist, tick, slotIndex) {
  if (!Array.isArray(playlist) || playlist.length === 0) return null;
  const n = playlist.length;
  const index = (((Number(tick) || 0) + (Number(slotIndex) || 0)) % n + n) % n;
  return playlist[index];
}

function hash32(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function videoStartSec(id, tick, durationSec) {
  const duration = Number(durationSec) || 0;
  if (duration < 45) return 0;
  const intro = Math.min(40, Math.max(15, Math.floor(duration * 0.07)));
  const endPad = Math.min(30, Math.max(12, Math.floor(duration * 0.06)));
  const span = Math.floor(duration - intro - endPad);
  if (span < 20) return intro;
  return intro + (hash32(`${id}:${tick}`) % span);
}

function rotationKey(card) {
  if (!card) return "";
  if (card.type === "logo") return `logo:${card.key || "cycle"}`;
  if (card.type === "amenity") return "amenity";
  if (card.type === "clock") return "clock";
  if (card.type === "pinboard" || card.type === "collage") return "pinboard";
  if (card.type === "leaderboard") return `board:${card.id || ""}`;
  if (card.type === "video") return `video:${card.id || ""}`;
  if (card.type === "youtube") return `youtube:${card.id || ""}`;
  return `${card.type}:${card.id || card.key || ""}`;
}

function manualCard(content, leaderboardId, playlist) {
  if (content === "logos") return { type: "logo", cycle: true };
  if (content === "amenities") return { type: "amenity", id: "amenities", cycle: true };
  if (content === "leaderboard") return { type: "leaderboard", id: leaderboardId || null };
  if (content === "pinboard") return { type: "pinboard", id: "pinboard", span: false };
  if (content === "video") {
    const video = (playlist || []).find((card) => card.type === "video");
    return video ? { ...video, mode: "card" } : { type: "video", id: "empty", empty: true, mode: "card" };
  }
  return null;
}

function withVideoStart(card, tick) {
  if (!card || card.type !== "video" || card.empty) return card;
  return { ...card, startSec: videoStartSec(card.id, tick, card.durationSec) };
}

function planRotation(playlist, options = {}) {
  const list = Array.isArray(playlist) ? playlist : [];
  const screens = Math.max(1, Math.min(3, Number(options.screenCount) || 3));
  const layout = options.layout || {};
  const tick = currentTick(options.startedAt, options.intervalSec, options.now);
  const used = new Set();
  const slots = { 1: null, 2: null, 3: null };
  for (const slot of ["1", "2", "3"]) {
    const content = layout[slot]?.content;
    if (content && content !== "rotation") {
      const card = manualCard(content, layout[slot].leaderboardId, list);
      const key = rotationKey(card);
      if (key) used.add(key);
      slots[slot] = withVideoStart(card, tick);
    }
  }
  for (let i = 1; i <= 3; i += 1) {
    const slot = String(i);
    if (slots[slot]) continue;
    if (i > screens || layout[slot]?.enabled === false) continue;
    const n = list.length;
    const slotIndex = i - 1;
    let chosen = null;
    for (let step = 0; step < n; step += 1) {
      const candidate = cardForSlot(list, tick, slotIndex + step);
      const key = rotationKey(candidate);
      if (!key || used.has(key)) continue;
      chosen = candidate;
      used.add(key);
      break;
    }
    slots[slot] = withVideoStart(chosen, tick);
  }
  return slots;
}

const rotationApi = {
  clampInterval,
  currentTick,
  tickForSlot,
  cardForSlot,
  hash32,
  videoStartSec,
  rotationKey,
  planRotation,
};

if (typeof module !== "undefined" && module.exports) module.exports = rotationApi;
if (typeof window !== "undefined") window.PinballRotation = rotationApi;
