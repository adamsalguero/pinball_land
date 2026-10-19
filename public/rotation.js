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

function videoStartSec(id, salt, durationSec) {
  const duration = Number(durationSec) || 0;
  if (!(duration > 1)) return 0;
  const unit = (hash32(`${id}:${salt}`) % 10001) / 10000;
  const fraction = 0.4 + unit * 0.2;
  const start = duration * fraction;
  const capped = Math.min(start, Math.max(0, duration - 0.5));
  return Math.round(capped * 100) / 100;
}

function logoPhaseKey(key, startedAt, intervalSec, now = Date.now(), min = 10) {
  const ms = clampInterval(intervalSec, min) * 1000;
  const origin = Number(startedAt);
  const start = Number.isFinite(origin) ? origin : now;
  const into = Math.max(0, now - start) % ms;
  const base = key === "pinball-land" ? "pinball-land" : "pinnacle";
  if (into < ms / 2) return base;
  return base === "pinnacle" ? "pinball-land" : "pinnacle";
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

function emptyVideo() {
  return { type: "video", id: "pending", url: "", title: "Video", empty: true, mode: "card", loop: false };
}

function openVideos(playlist) {
  return (playlist || []).filter((card) => card && card.type === "video" && card.url && !card.empty);
}

function clipCard(card, salt) {
  if (!card) return card;
  const startSec = card.stream ? 0 : videoStartSec(card.id, salt, card.durationSec);
  return {
    ...card,
    mode: card.mode || "card",
    loop: false,
    blocked: false,
    startSec,
    playId: `${card.id}:${salt}`,
  };
}

function reserveClip(used, card) {
  const key = rotationKey(card);
  if (key) used.add(key);
  if (card && card.type === "video" && card.url) used.add(`url:${card.url}`);
}

function clipTaken(used, card) {
  if (!card) return true;
  const key = rotationKey(card);
  if (!key || used.has(key)) return true;
  if (card.type === "video" && card.url && used.has(`url:${card.url}`)) return true;
  return false;
}

function pickDistinctVideo(videos, salt, used) {
  const pool = (videos || []).filter((card) => card && card.url && !card.empty && !clipTaken(used, card));
  if (!pool.length) return null;
  return pool[hash32(String(salt)) % pool.length];
}

function pickPinnedVideo(playlist, salt, used = new Set()) {
  const videos = openVideos(playlist);
  if (!videos.length) return emptyVideo();
  const chosen = pickDistinctVideo(videos, salt, used);
  if (!chosen) return null;
  return clipCard(chosen, salt);
}

function withVideoStart(card, tick) {
  if (!card || card.type !== "video" || card.empty) return card;
  if (card.stream) return { ...card, startSec: 0, playId: card.playId || `${card.id}:${tick}` };
  return clipCard(card, tick);
}

function nonVideoReplacement(playlist, used) {
  const cards = Array.isArray(playlist) ? playlist : [];
  const nonLogo = cards.filter((card) => card && card.type !== "video" && card.type !== "logo");
  for (const card of nonLogo) {
    const key = rotationKey(card);
    if (key && !used.has(key)) return card;
  }
  for (const card of cards) {
    if (!card || card.type !== "logo") continue;
    const key = rotationKey(card);
    if (key && !used.has(key)) return card;
  }
  return nonLogo[0] || { type: "clock", id: "clock" };
}

function replacementFor(plan, slot, playlist, options = {}) {
  const failed = options.failedIds instanceof Set ? options.failedIds : new Set(options.failedIds || []);
  const used = new Set();
  for (const [other, card] of Object.entries(plan || {})) {
    if (String(other) === String(slot) || !card) continue;
    reserveClip(used, card);
  }
  const videos = openVideos(playlist).filter((card) => !failed.has(card.id) && !used.has(`url:${card.url}`));
  const salt = options.salt || `${slot}:retry`;
  const chosen = pickDistinctVideo(videos, salt, used);
  if (chosen) return clipCard(chosen, salt);
  return nonVideoReplacement(playlist, used);
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
        const videos = openVideos(list);
        const memory = options.videoMemory?.[slot];
        const gen = memory?.gen || 0;
        const salt = `${slot}:${gen}`;
        let chosen = null;
        if (memory?.id) {
          const saved = videos.find((card) => card.id === memory.id);
          if (saved && !used.has(rotationKey(saved))) chosen = clipCard(saved, salt);
        }
        if (!chosen && videos.length) {
          const fresh = pickDistinctVideo(videos, `${salt}:${videos.map((card) => card.id).join(",")}`, used);
          if (fresh) chosen = clipCard(fresh, salt);
        }
        if (chosen) {
          reserveClip(used, chosen);
          slots[slot] = prepare(chosen, slot);
        } else if (!videos.length) {
          slots[slot] = prepare(emptyVideo(), slot);
        } else {
          slots[slot] = prepare(nonVideoReplacement(list, used), slot);
          reserveClip(used, slots[slot]);
        }
        continue;
      }
      const card = prepare(manualCard(content, layout[slot].leaderboardId, list), slot);
      reserveClip(used, card);
      slots[slot] = withVideoStart(card, tick);
    }
  }
  const rotationSlots = [];
  for (let i = 1; i <= 3; i += 1) {
    const slot = String(i);
    if (slots[slot]) continue;
    if (i > screens || layout[slot]?.enabled === false) continue;
    rotationSlots.push(slot);
  }
  const n = list.length;
  // One auto holiday clip, walking left, center, right with each dwell.
  // The play id stays the clip id for that whole slot, so the screen does not
  // reload it until the dwell moves it. A pinned video is the only way a
  // second screen plays a clip at the same time.
  const holidayVideos = [];
  const seenHoliday = new Set();
  for (const source of list) {
    if (!source || source.type !== "video" || !source.url || source.blocked || source.empty || !source.holiday) continue;
    if (seenHoliday.has(source.url)) continue;
    seenHoliday.add(source.url);
    holidayVideos.push(source);
  }
  const autoSlots = rotationSlots.filter((slot) => !slots[slot]);
  if (holidayVideos.length && autoSlots.length) {
    // One clip walks left, center, right and stays for that whole dwell.
    // The next clip gets the next pass, so a playlist with two cartoons
    // still plays both without putting two screens on video.
    const span = autoSlots.length * holidayVideos.length;
    const step = ((Number(tick) || 0) % span + span) % span;
    const owner = autoSlots[step % autoSlots.length];
    const start = Math.floor(step / autoSlots.length) % holidayVideos.length;
    for (let hop = 0; hop < holidayVideos.length; hop += 1) {
      const source = holidayVideos[(start + hop) % holidayVideos.length];
      if (clipTaken(used, source)) continue;
      const chosen = withVideoStart(prepare(source, owner), `${source.id}:${owner}`);
      reserveClip(used, chosen);
      slots[owner] = chosen;
      break;
    }
  }
  const inWindow = new Set();
  for (let offset = 0; offset < rotationSlots.length && n; offset += 1) {
    inWindow.add((((tick + offset) % n) + n) % n);
  }
  const autoHasVideo = () => rotationSlots.some((slot) => slots[slot]?.type === "video" && slots[slot].url);
  // Other clips stay on the screen that owns their playlist index. The next
  // dwell must not slide one onto a neighbor. Auto still shows only one clip.
  for (const index of inWindow) {
    if (autoHasVideo()) break;
    const source = list[index];
    if (!source || source.type !== "video" || !source.url || source.blocked || source.empty || source.holiday) continue;
    const owner = rotationSlots[index % rotationSlots.length];
    if (!owner || slots[owner] || clipTaken(used, source)) continue;
    const chosen = withVideoStart(prepare(source, owner), source.id);
    reserveClip(used, chosen);
    slots[owner] = chosen;
  }
  rotationSlots.forEach((slot, slotIndex) => {
    if (slots[slot]) return;
    let chosen = null;
    for (let step = 0; step < n; step += 1) {
      const candidate = prepare(cardForSlot(list, tick, slotIndex + step), slot);
      if (candidate?.type === "video") continue;
      if (clipTaken(used, candidate)) continue;
      chosen = candidate;
      reserveClip(used, chosen);
      break;
    }
    if (!chosen) {
      chosen = nonVideoReplacement(list, used);
      reserveClip(used, chosen);
    }
    slots[slot] = chosen;
  });
  return slots;
}

const rotationApi = {
  clampInterval,
  currentTick,
  tickForSlot,
  cardForSlot,
  hash32,
  videoStartSec,
  logoPhaseKey,
  rotationKey,
  planRotation,
  pickDistinctVideo,
  replacementFor,
  openVideos,
};

if (typeof module !== "undefined" && module.exports) module.exports = rotationApi;
if (typeof window !== "undefined") window.PinballRotation = rotationApi;
