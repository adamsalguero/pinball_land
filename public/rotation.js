function clampInterval(value, min = 10) {
  const floor = Math.min(30, Math.max(1, Number(min) || 10));
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return Math.max(floor, 30);
  return Math.min(120, Math.max(floor, n));
}

function currentTick(startedAt, intervalSec, now = Date.now(), min = 10) {
  const ms = clampInterval(intervalSec, min) * 1000;
  const start = Number(startedAt);
  const origin = Number.isFinite(start) ? start : now;
  return Math.floor(Math.max(0, now - origin) / ms);
}

// Every screen shares one dwell clock. Slot index only picks a different card.
function tickForSlot(startedAt, intervalSec, _slotIndex, _screenCount, now = Date.now(), min = 10) {
  return currentTick(startedAt, intervalSec, now, min);
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
  if (card.type === "pinboard" || card.type === "collage" || card.type === "photos") return "pinboard";
  if (card.type === "leaderboard") return "leaderboard";
  if (card.type === "video") return `video:${card.id || ""}`;
  if (card.type === "youtube") return `youtube:${card.id || ""}`;
  return `${card.type}:${card.id || card.key || ""}`;
}

function manualCard(content, leaderboardId, playlist) {
  if (content === "logos") return { type: "logo", cycle: true };
  if (content === "amenities") return { type: "amenity", id: "amenities", cycle: true };
  if (content === "leaderboard") return { type: "leaderboard", id: leaderboardId || null };
  if (content === "pinboard") return { type: "pinboard", id: "pinboard", span: false };
  if (content === "clock") return { type: "clock", id: "clock" };
  if (content === "video") return pickPinnedVideo(playlist, 0);
  return null;
}

function pickPinnedVideo(playlist, cursor) {
  const videos = (playlist || []).filter((card) => card && card.type === "video" && card.url && !card.empty);
  if (!videos.length) {
    return { type: "video", id: "pending", url: "", title: "Video", empty: true, mode: "card", loop: false };
  }
  const open = videos.filter((card) => !card.blocked);
  const pool = open.length ? open : videos;
  const index = Math.abs(Math.trunc(Number(cursor) || 0)) % pool.length;
  return { ...pool[index], mode: "card", loop: false, blocked: false };
}

function withVideoStart(card, tick) {
  if (!card || card.type !== "video" || card.empty) return card;
  if (card.stream) return { ...card, startSec: 0 };
  return { ...card, startSec: videoStartSec(card.id, tick, card.durationSec) };
}

function planRotation(playlist, options = {}) {
  const list = Array.isArray(playlist) ? playlist : [];
  const screens = Math.max(1, Math.min(3, Number(options.screenCount) || 3));
  const layout = options.layout || {};
  const min = Number(options.minInterval) || 10;
  const tick = currentTick(options.startedAt, options.intervalSec, options.now, min);
  const prepare = typeof options.prepare === "function" ? options.prepare : (card) => card;
  const used = new Set();
  const slots = { 1: null, 2: null, 3: null };
  for (const slot of ["1", "2", "3"]) {
    const content = layout[slot]?.content;
    if (content && content !== "rotation") {
      if (content === "video") {
        const card = prepare(pickPinnedVideo(list, options.videoCursor), slot);
        const key = rotationKey(card);
        if (key && !card.empty) used.add(key);
        slots[slot] = card && !card.empty
          ? { ...card, startSec: 0, playId: Math.abs(Math.trunc(Number(options.videoCursor) || 0)) }
          : card;
        continue;
      }
      const card = prepare(manualCard(content, layout[slot].leaderboardId, list), slot);
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
      const candidate = prepare(cardForSlot(list, tick, slotIndex + step), slot);
      if (candidate?.type === "video" && candidate.blocked) continue;
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
