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

function planSlots(plan) {
  return {
    1: plan?.[1] || plan?.["1"] || null,
    2: plan?.[2] || plan?.["2"] || null,
    3: plan?.[3] || plan?.["3"] || null,
  };
}

function videoUrl(card) {
  if (!card || card.type !== "video" || card.empty || !card.url) return "";
  return String(card.url);
}

function slotsHolding(plan, url) {
  if (!url) return [];
  return ["1", "2", "3"].filter((slot) => videoUrl(plan?.[slot]) === url);
}

function heldReplacement(plan, slot, playlist) {
  const used = new Set();
  for (const other of ["1", "2", "3"]) {
    if (other === String(slot)) continue;
    reserveClip(used, plan[other]);
  }
  const picked = nonVideoReplacement(playlist, used);
  if (picked && picked.type !== "video") {
    const key = rotationKey(picked);
    if (key && !used.has(key)) return { ...picked };
  }
  const fallbacks = [
    { type: "clock", id: "clock" },
    { type: "amenity", id: "arcade" },
    { type: "amenity", id: "oasis" },
    { type: "amenity", id: "events" },
    { type: "pinboard", id: "pinboard", span: false },
    { type: "logo", key: "pinnacle" },
    { type: "logo", key: "pinball-land" },
  ];
  for (const candidate of fallbacks) {
    const key = rotationKey(candidate);
    if (key && !used.has(key)) return { ...candidate };
  }
  return { type: "clock", id: "clock" };
}

function stripUrl(plan, url, playlist) {
  for (const slot of slotsHolding(plan, url)) {
    plan[slot] = heldReplacement(plan, slot, playlist);
  }
}

function uniqueCards(plan, playlist) {
  const seenUrls = new Set();
  const seenKeys = new Set();
  for (const slot of ["1", "2", "3"]) {
    const url = videoUrl(plan[slot]);
    const key = rotationKey(plan[slot]);
    const duplicate = (url && seenUrls.has(url)) || (key && seenKeys.has(key));
    if (duplicate) plan[slot] = heldReplacement(plan, slot, playlist);
    const nextUrl = videoUrl(plan[slot]);
    const nextKey = rotationKey(plan[slot]);
    if (nextUrl) seenUrls.add(nextUrl);
    if (nextKey) seenKeys.add(nextKey);
  }
}

// The planner already gives a holiday clip to one screen per dwell. Displays
// apply that plan on their own sockets, so the screen it is walking onto can
// stage it before the screen it is leaving has stopped. Hold the clip back
// until the previous screen releases it. The served plan then has the file on
// nobody, and the next plan must not advertise it either.
function applyClipHandoff(desired, nextDesired, handoff, playlist) {
  const granted = { ...(handoff?.granted || {}) };
  const released = { ...(handoff?.released || {}) };
  const plan = planSlots(desired);
  const nextPlan = planSlots(nextDesired);
  const urls = new Set();
  for (const slot of ["1", "2", "3"]) {
    const current = videoUrl(plan[slot]);
    const upcoming = videoUrl(nextPlan[slot]);
    if (current) urls.add(current);
    if (upcoming) urls.add(upcoming);
  }
  for (const url of Object.keys(granted)) urls.add(url);
  for (const url of urls) {
    const owners = slotsHolding(plan, url);
    for (const extra of owners.slice(1)) plan[extra] = heldReplacement(plan, extra, playlist);
    const desiredOwner = owners[0] || "";
    const prev = granted[url] || "";
    if (!desiredOwner) {
      if (prev && released[url] !== prev) stripUrl(nextPlan, url, playlist);
      else {
        delete granted[url];
        delete released[url];
      }
      continue;
    }
    if (!prev || prev === desiredOwner) {
      granted[url] = desiredOwner;
      if (released[url] === desiredOwner) delete released[url];
      continue;
    }
    if (released[url] === prev) {
      granted[url] = desiredOwner;
      delete released[url];
      continue;
    }
    plan[desiredOwner] = heldReplacement(plan, desiredOwner, playlist);
    stripUrl(nextPlan, url, playlist);
  }
  uniqueCards(plan, playlist);
  uniqueCards(nextPlan, playlist);
  return { plan, nextPlan, handoff: { granted, released } };
}

function noteClipRelease(handoff, url, slot) {
  const granted = { ...(handoff?.granted || {}) };
  const released = { ...(handoff?.released || {}) };
  const clip = String(url || "");
  const owner = String(slot || "");
  if (!clip || !granted[clip] || granted[clip] !== owner) {
    return { granted, released, changed: false };
  }
  if (released[clip] === owner) return { granted, released, changed: false };
  released[clip] = owner;
  return { granted, released, changed: true };
}

function noteClipIdle(handoff, slot) {
  const granted = { ...(handoff?.granted || {}) };
  const released = { ...(handoff?.released || {}) };
  const owner = String(slot || "");
  let changed = false;
  if (!["1", "2", "3"].includes(owner)) return { granted, released, changed: false };
  for (const [url, holder] of Object.entries(granted)) {
    if (holder !== owner || released[url] === owner) continue;
    released[url] = owner;
    changed = true;
  }
  return { granted, released, changed };
}

function slotMayPlay(plan, nextPlan, slot, url) {
  const clip = String(url || "");
  const mine = String(slot || "");
  if (!clip) return false;
  const owners = slotsHolding(plan, clip);
  if (owners.length) return owners[0] === mine;
  if (slotsHolding(nextPlan, clip).length) return false;
  return true;
}

function clipsToRelease(previousPlan, nextPlan, slot, showingUrl) {
  const id = String(slot || "");
  const prev = previousPlan?.[id];
  const mine = nextPlan?.[id];
  const keep = videoUrl(mine);
  const drop = new Set();
  const prevUrl = videoUrl(prev);
  if (prevUrl && prevUrl !== keep) drop.add(prevUrl);
  const showing = String(showingUrl || "");
  if (showing && showing !== keep) drop.add(showing);
  return [...drop];
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
        const playlistVideos = openVideos(list);
        const memory = options.videoMemory?.[slot];
        const gen = memory?.gen || 0;
        const salt = `${slot}:${gen}`;
        const clipId = String(layout[slot]?.clipId || "").replace(/^starter:/, "");
        let chosen = null;
        if (clipId) {
          const saved = playlistVideos.find((card) => (
            card.starterId === clipId || card.id === clipId || card.id === `starter:${clipId}`
          ));
          if (saved) chosen = clipCard(saved, salt);
        } else if (playlistVideos.length) {
          if (memory?.id) {
            const saved = playlistVideos.find((card) => card.id === memory.id);
            if (saved && !used.has(rotationKey(saved))) chosen = clipCard(saved, salt);
          }
          if (!chosen) {
            const fresh = pickDistinctVideo(
              playlistVideos,
              `${salt}:${playlistVideos.map((card) => card.id).join(",")}`,
              used,
            );
            if (fresh) chosen = clipCard(fresh, salt);
          }
          if (!chosen) {
            slots[slot] = prepare(nonVideoReplacement(list, used), slot);
            reserveClip(used, slots[slot]);
            continue;
          }
        }
        if (chosen) {
          reserveClip(used, chosen);
          slots[slot] = prepare(chosen, slot);
          continue;
        }
      } else {
        const card = prepare(manualCard(content, layout[slot].leaderboardId, list), slot);
        reserveClip(used, card);
        slots[slot] = withVideoStart(card, tick);
      }
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
  applyClipHandoff,
  noteClipRelease,
  noteClipIdle,
  slotMayPlay,
  clipsToRelease,
};

if (typeof module !== "undefined" && module.exports) module.exports = rotationApi;
if (typeof window !== "undefined") window.PinballRotation = rotationApi;
