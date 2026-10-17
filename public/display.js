const SLOT = location.pathname.split("/").pop();

const screen = document.getElementById("screen");
const logoPanel = document.getElementById("logo");
const logoImage = document.getElementById("logo-image");
const logoFallback = document.getElementById("logo-fallback");
const amenityPanel = document.getElementById("amenity");
const amenityFrame = document.getElementById("amenity-frame");
const amenityPhoto = document.getElementById("amenity-photo");
const amenityHeadline = document.getElementById("amenity-headline");
const amenityBody = document.getElementById("amenity-body");
const amenityTypes = document.getElementById("amenity-types");
const boardPanel = document.getElementById("board");
const boardTitle = document.getElementById("board-title");
const boardMeta = document.getElementById("board-meta");
const boardRows = document.getElementById("board-rows");
const boardEmpty = document.getElementById("board-empty");
const machineArtWrap = document.getElementById("machine-art-wrap");
const machineArt = document.getElementById("machine-art");
const machineVideo = document.getElementById("machine-video");
const presentPanel = document.getElementById("present");
const presentWaiting = document.getElementById("present-waiting");
const presentHeading = document.getElementById("present-heading");
const presentCode = document.getElementById("present-code");
const presentInstructions = document.getElementById("present-instructions");
const presentVideo = document.getElementById("present-video");
const presentImage = document.getElementById("present-image");
const presentFrame = document.getElementById("present-frame");
const videoPanel = document.getElementById("video-panel");
const wallVideo = document.getElementById("wall-video");
const clockPanel = document.getElementById("clock");
const clockTime = document.getElementById("clock-time");
const clockEvent = document.getElementById("clock-event");
const pinboardPanel = document.getElementById("pinboard");
const pinWall = document.getElementById("pin-wall");
const collagePanel = document.getElementById("collage");
const collageGrid = document.getElementById("collage-grid");
const youtubePanel = document.getElementById("youtube");
const motionCanvas = document.getElementById("motion");
const podium = document.getElementById("podium");

let payload = null;
let lastKey = "";
let socket = null;
let pc = null;
let iceQueue = [];
let signalChain = Promise.resolve();
let shownPresentId = null;
let shownPresentSource = null;
let helloId = null;
let mirrorId = null;
let syncTimer = null;
const pendingMessages = [];
const params = new URLSearchParams(location.search);
const SHOT = params.has("shot");
const FIXTURE = params.get("fixture") === "long";
const LONG_TEXT = "Flexible event options for charity fundraisers, client appreciation, team gatherings, and outdoor oasis receptions at Pinnacle Entertainment Center ".repeat(4);
const AMENITY_ORDER = ["arcade", "oasis", "events"];
const LOGO_ORDER = ["pinnacle", "pinball-land"];
const AMENITY_DWELL_MS = 12000;
let transitionToken = 0;
let motionField = null;
let motionTheme = "";
let lastFrame = 0;

function queryTheme() {
  const theme = params.get("theme");
  return theme === "halloween" || theme === "christmas" || theme === "pinnacle" ? theme : "";
}

function transitionsOn() {
  return !SHOT && payload?.motion !== "off";
}

function setFit(el, text) {
  if (!el) return;
  const value = text || "";
  el.dataset.full = value;
  el.textContent = value;
}

function fitText(el) {
  if (!el || el.closest("[hidden]")) return;
  const full = el.dataset.full ?? "";
  if (!full) return;
  el.style.fontSize = "";
  el.style.maxHeight = "";
  el.style.lineHeight = "";
  el.textContent = full;
  if (el.clientWidth < 2 || el.clientHeight < 2) return;
  const start = Math.max(11, Math.round(parseFloat(getComputedStyle(el).fontSize) || 32));
  const boxHeight = el.clientHeight;
  const overflows = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  el.style.fontSize = `${start}px`;
  if (!overflows()) return;
  // Keep the laid-out box. An em max-height would shrink with the font and the line would never fit.
  el.style.maxHeight = `${boxHeight}px`;
  el.style.lineHeight = "1.15";
  const keepWhole = el.dataset.fitFull === "1";
  const absurd = !keepWhole && full.length > 180;
  const min = keepWhole ? 6 : absurd ? 8 : 11;
  let lo = min;
  let hi = start;
  let best = min;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    el.style.fontSize = `${mid}px`;
    if (overflows()) hi = mid - 1;
    else {
      best = mid;
      lo = mid + 1;
    }
  }
  el.style.fontSize = `${best}px`;
  if (!overflows() || el.dataset.fitFull === "1" || !absurd) return;
  lo = 1;
  hi = full.length;
  let fitted = "…";
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    el.textContent = mid >= full.length ? full : `${full.slice(0, mid).trimEnd()}…`;
    if (overflows()) hi = mid - 1;
    else {
      fitted = el.textContent;
      lo = mid + 1;
    }
  }
  el.textContent = fitted;
}

function fitVisibleText() {
  for (const el of document.querySelectorAll("[data-fit], [data-full]")) {
    if (el.closest("[hidden]")) continue;
    fitText(el);
  }
}

function formatScore(score) {
  return Number(score || 0).toLocaleString("en-US");
}

function applyTheme(theme) {
  const forced = queryTheme();
  const name = forced || (theme === "halloween" || theme === "christmas" ? theme : "pinnacle");
  document.documentElement.dataset.theme = name;
}

function setMode(mode) {
  screen.dataset.mode = mode;
  logoPanel.hidden = mode !== "logo";
  amenityPanel.hidden = mode !== "amenity";
  boardPanel.hidden = mode !== "board";
  presentPanel.hidden = mode !== "present";
  videoPanel.hidden = mode !== "video";
  clockPanel.hidden = mode !== "clock";
  pinboardPanel.hidden = mode !== "pinboard";
  collagePanel.hidden = mode !== "collage";
  youtubePanel.hidden = mode !== "youtube";
  if (mode !== "youtube") youtubePanel.replaceChildren();
}

function clearSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  clearStall();
}

function stopWallVideo() {
  clearSync();
  wallVideo.onended = null;
  wallVideo.onloadedmetadata = null;
  wallVideo.pause();
  wallVideo.removeAttribute("src");
  wallVideo.classList.remove("span");
  wallVideo.style.width = "";
  wallVideo.style.transform = "";
}

function teardownPresent() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.close();
    pc = null;
  }
  iceQueue = [];
  helloId = null;
  shownPresentId = null;
  shownPresentSource = null;
  presentVideo.srcObject = null;
  presentVideo.hidden = true;
  presentImage.hidden = true;
  presentImage.removeAttribute("src");
  presentFrame.hidden = true;
  presentFrame.src = "about:blank";
}

function showOff() {
  showLogo("", "Pinball Land");
}

function showLogo(url, label) {
  setMode("logo");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  logoImage.alt = label;
  setFit(logoFallback, FIXTURE ? `${label} ${LONG_TEXT}` : `${label} — add the file in public/logos`);
  if (url) {
    logoFallback.hidden = true;
    logoImage.hidden = false;
    if (logoImage.src !== url) logoImage.src = url;
  } else {
    logoImage.removeAttribute("src");
    logoImage.hidden = true;
    logoFallback.hidden = false;
  }
}

logoImage.addEventListener("error", () => {
  logoImage.hidden = true;
  logoFallback.hidden = false;
});

function showAmenity(amenity, photos) {
  setMode("amenity");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  setFit(amenityHeadline, FIXTURE ? `${amenity?.headline || "Amenities"} ${LONG_TEXT}` : (amenity?.headline || ""));
  setFit(amenityBody, FIXTURE ? LONG_TEXT : (amenity?.body || ""));
  const types = FIXTURE ? LONG_TEXT : (amenity?.eventTypes || "");
  if (types) {
    amenityTypes.hidden = false;
    setFit(amenityTypes, types);
  } else {
    amenityTypes.hidden = true;
    setFit(amenityTypes, "");
  }
  const photoUrl = amenity?.photo ? photos?.[amenity.photo] : null;
  if (photoUrl) {
    amenityFrame.hidden = false;
    amenityPhoto.alt = amenity.headline;
    if (amenityPhoto.src !== photoUrl) amenityPhoto.src = photoUrl;
  } else {
    amenityFrame.hidden = true;
    amenityPhoto.removeAttribute("src");
  }
}

function stopVideo() {
  machineVideo.pause();
  machineVideo.removeAttribute("src");
  machineVideo.hidden = true;
}

function renderRows(rows) {
  boardRows.replaceChildren();
  podium.replaceChildren();
  const top = rows.slice(0, 3);
  const rest = rows.slice(3);
  podium.hidden = top.length === 0;
  boardEmpty.hidden = rows.length > 0;
  boardRows.hidden = rest.length === 0 && top.length > 0 ? true : rows.length === 0;
  if (top.length) {
    const order = [top[1], top[0], top[2]].filter(Boolean);
    order.forEach((row) => {
      const place = top.indexOf(row) + 1;
      const card = document.createElement("article");
      card.className = `podium-card place-${place}`;
      card.innerHTML = `<p class="place">${place === 1 ? "First" : place === 2 ? "Second" : "Third"}</p><span class="who" data-fit="1" data-fit-full="1"></span><span class="points" data-fit="1" data-fit-full="1"></span>`;
      setFit(card.querySelector(".who"), row.name || "—");
      setFit(card.querySelector(".points"), formatScore(row.score));
      podium.append(card);
    });
  }
  rest.forEach((row, index) => {
    const li = document.createElement("li");
    li.className = "board-row";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 4).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "name";
    name.setAttribute("data-fit", "1");
    name.setAttribute("data-fit-full", "1");
    setFit(name, row.name || "—");
    const score = document.createElement("span");
    score.className = "score";
    score.setAttribute("data-fit", "1");
    score.setAttribute("data-fit-full", "1");
    setFit(score, formatScore(row.score));
    li.append(rank, name, score);
    boardRows.append(li);
  });
  if (top.length && !rest.length) boardRows.hidden = true;
}

let shownBoard = null;

function boardArtList(board) {
  if (!board || board.kind !== "machine") return [];
  const urls = Array.isArray(board.artUrls) ? board.artUrls.filter(Boolean) : [];
  if (urls.length) return urls;
  return board.artUrl ? [board.artUrl] : [];
}

function currentBoardArt(board) {
  const urls = boardArtList(board);
  if (!urls.length) return null;
  const cursor = Math.floor(Math.max(0, Date.now() - clockSkew) / 8000);
  return urls[cursor % urls.length];
}

function paintBoardArt() {
  const board = shownBoard;
  const artUrl = currentBoardArt(board);
  const isMachine = board?.kind === "machine";
  boardPanel.classList.toggle("has-art", Boolean(isMachine && artUrl));
  if (!artUrl) {
    machineArtWrap.hidden = true;
    machineArt.hidden = true;
    machineVideo.hidden = true;
    machineArt.removeAttribute("src");
    delete machineArt.dataset.src;
    return;
  }
  machineVideo.hidden = true;
  machineArtWrap.hidden = false;
  machineArt.hidden = false;
  machineArt.alt = board.name || "Machine art";
  if (machineArt.dataset.src !== artUrl) {
    machineArt.dataset.src = artUrl;
    machineArt.src = artUrl;
  }
}

const NAMED_BOARD_ROWS = [
  { id: "named-1", name: "Alexander Montgomery-Parra", score: 500000000 },
  { id: "named-2", name: "Adam Salguero", score: 6000 },
  { id: "named-3", name: "RetroHardroc", score: 50 },
  { id: "named-4", name: "John Smith", score: 200 },
  { id: "named-5", name: "Montgomery Alexander-Parra", score: 5000 },
];

function showBoard(board) {
  setMode("board");
  stopWallVideo();
  teardownPresent();
  shownBoard = board || null;
  if (FIXTURE && params.get("art") === "1") {
    shownBoard = {
      kind: "machine",
      name: "The Wizard of Oz (75th Anniversary Edition)",
      artUrl: "/photos/arcade.jpg",
      artUrls: ["/photos/arcade.jpg", "/photos/oasis.jpg", "/photos/bar.jpg"],
    };
  }
  const rows = FIXTURE ? NAMED_BOARD_ROWS : (board?.rows || []);
  const logo = document.getElementById("machine-logo");
  if (logo) {
    if (board?.logoUrl) {
      logo.hidden = false;
      logo.alt = `${board.name || "Machine"} logo`;
      if (logo.getAttribute("src") !== board.logoUrl) logo.src = board.logoUrl;
    } else {
      logo.hidden = true;
      logo.removeAttribute("src");
    }
  }
  setFit(boardTitle, FIXTURE ? "The Wizard of Oz (75th Anniversary Edition)" : (board?.name || "Leaderboard"));
  const meta = FIXTURE ? "Jersey Jack Pinball · 2014" : [board?.manufacturer, board?.year].filter(Boolean).join(" · ");
  boardMeta.hidden = !meta;
  setFit(boardMeta, meta);
  renderRows(rows);

  stopVideo();
  paintBoardArt();
}

function cyclePick(order, dwell, slot) {
  const count = order.length;
  const screens = Math.max(1, Number(payload?.displays?.count) || 3);
  const index = Math.max(0, Number(slot) || 0) % screens;
  const offset = (index % count) * (dwell / count);
  const now = Date.now() - clockSkew - offset;
  return order[Math.floor(Math.max(0, now) / dwell) % count];
}

function slotIndex() {
  const n = Number.parseInt(SLOT, 10);
  return Number.isFinite(n) && n > 0 ? n - 1 : 0;
}

function pinnedVideo() {
  const card = (payload?.playlist || []).find((item) => item.type === "video");
  if (card) return { ...card, mode: card.mode || "card" };
  const video = payload?.media?.videos?.[0];
  if (video?.url) {
    return { type: "video", id: video.id, url: video.url, title: video.title || "Video", loop: true, mode: "card" };
  }
  return { type: "video", id: "empty", url: "", title: "Video", empty: true, mode: "card" };
}

function cardFromContent(content, leaderboardId) {
  if (!content || content === "rotation" || content === "off" || content === "black" || content === "dark") return null;
  if (content === "logos") return { type: "logo", cycle: true };
  if (content === "pinnacle" || content === "pinball-land") return { type: "logo", key: content };
  if (content === "amenities") return { type: "amenity", id: "amenities", cycle: true };
  if (content === "amenity-arcade" || content === "amenity-oasis" || content === "amenity-events") {
    return { type: "amenity", id: content.replace("amenity-", "") };
  }
  if (content === "leaderboard") return { type: "leaderboard", id: leaderboardId };
  if (content === "pinboard" || content === "photos" || content === "collage") {
    return { type: "pinboard", span: false };
  }
  if (content === "video") return pinnedVideo();
  if (content === "clock") return { type: "clock" };
  return null;
}

function cardFromSlot(state) {
  const slot = state.slots?.[SLOT];
  return cardFromContent(slot?.content, slot?.leaderboardId) || { type: "logo", cycle: true };
}

function previewCard() {
  const preview = params.get("preview");
  if (!preview || !payload) return null;
  if (preview === "logo" || preview === "logos") return { type: "logo", key: params.get("logo") || "pinnacle" };
  if (preview === "amenities") return { type: "amenity", id: "amenities", cycle: true };
  if (preview === "amenity") {
    const id = params.get("amenity");
    return { type: "amenity", id: AMENITY_ORDER.includes(id) ? id : "arcade" };
  }
  if (preview === "board") return { type: "leaderboard", id: payload.state?.leaderboards?.[0]?.id };
  if (preview === "collage") return { type: "pinboard", span: false };
  if (preview === "pinboard" || preview === "clock") return { type: preview, span: false };
  if (preview === "video") return { type: "video", id: "preview", url: "", title: "Video", empty: true, mode: "card" };
  return null;
}

function resolveCard() {
  const forced = previewCard();
  if (forced) return forced;
  const state = payload?.state;
  if (!state) return { type: "logo", key: "pinnacle" };
  const presentation = payload.presentations?.[SLOT];
  if (presentation?.source) return { type: "present", presentation };
  const playback = payload.playback;
  if (playback?.kind === "youtube" && Array.isArray(playback.slots) && playback.slots.map(String).includes(String(SLOT))) {
    return { type: "youtube", id: playback.videoId, embed: playback.embed, title: playback.title };
  }
  if (playback?.url && Array.isArray(playback.slots) && playback.slots.map(String).includes(String(SLOT))) {
    return {
      type: "video",
      id: playback.videoId,
      url: playback.url,
      title: playback.title,
      loop: Boolean(playback.loop),
      mode: playback.mode,
      startedAt: playback.startedAt,
      slots: playback.slots.map(String),
    };
  }
  if (state.rotation?.enabled !== false && payload.rotationPlan) {
    const planned = payload.rotationPlan[SLOT] || payload.rotationPlan[String(SLOT)] || null;
    if (planned) return { ...planned, span: false };
  }
  const layout = payload.layout?.[SLOT];
  if (layout && layout.content && layout.content !== "rotation") {
    const pinned = cardFromContent(layout.content, layout.leaderboardId);
    if (pinned) return pinned;
  }
  return cardFromSlot(state);
}

function decorate(card) {
  if (!card || card.type === "off") return { type: "logo", cycle: true };
  if (card.type === "amenity" && (card.cycle || card.id === "amenities")) {
    return { ...card, type: "amenity", id: cyclePick(AMENITY_ORDER, AMENITY_DWELL_MS, slotIndex()) };
  }
  if (card.type === "logo" && card.cycle) {
    return { ...card, key: cyclePick(LOGO_ORDER, AMENITY_DWELL_MS, slotIndex()) };
  }
  return card;
}

function cardKey(card) {
  if (!card) return "off";
  if (card.type === "present") {
    const item = card.presentation;
    return `present:${item.id}:${item.source}:${item.url || ""}:${item.fileUrl || ""}:${item.code || ""}:${item.helper?.ok}:${item.helper?.capture}:${item.helper?.error || ""}`;
  }
  if (card.type === "logo") return `logo:${card.key}`;
  if (card.type === "amenity") return `amenity:${card.id}`;
  if (card.type === "leaderboard") return `board:${card.id}`;
  if (card.type === "video") {
    return `video:${card.id}:${card.mode}:${card.startSec || ""}:${card.startedAt || ""}:${(card.slots || []).join(",")}`;
  }
  if (card.type === "pinboard" || card.type === "collage") {
    const ids = (payload?.guest?.photos || []).map((photo) => photo.id).join(",");
    return `${card.type}:${ids}`;
  }
  if (card.type === "youtube") return `youtube:${card.id}:${card.embed || ""}`;
  if (card.type === "clock") return "clock";
  return card.type || "off";
}

function boardKey(board) {
  if (!board) return "board:missing";
  const rows = (board.rows || []).map((row) => `${row.id}:${row.score}:${row.name}`).join(",");
  return `board:${board.id}:${board.artUrl || ""}:${board.videoUrl || ""}:${rows}`;
}

function paintCard(card) {
  const logos = payload?.logos || {};
  const photos = payload?.photos || {};
  const amenities = payload?.amenities || [];
  if (!card || card.type === "off") {
    showOff();
    return;
  }
  if (card.type === "present") {
    showPresent(card.presentation);
    return;
  }
  if (card.type === "logo") {
    const label = card.key === "pinball-land"
      ? "Pinnacle Entertainment Center"
      : "Pinnacle Group Financial Services";
    showLogo(logos[card.key], card.label || label);
    return;
  }
  if (card.type === "amenity") {
    showAmenity(amenities.find((item) => item.id === card.id), photos);
    return;
  }
  if (card.type === "video") {
    showVideo(card);
    return;
  }
  if (card.type === "clock") {
    showClock();
    return;
  }
  if (card.type === "pinboard") {
    showPinboard(card);
    return;
  }
  if (card.type === "collage") {
    showCollage();
    return;
  }
  if (card.type === "youtube") {
    showYoutube(card);
    return;
  }
  const board = (payload.state.leaderboards || []).find((item) => item.id === card.id);
  showBoard(board);
}

function renderCard(raw) {
  const card = decorate(raw);
  let key = cardKey(card);
  if (card?.type === "leaderboard") {
    const board = (payload.state.leaderboards || []).find((item) => item.id === card.id);
    key = boardKey(board);
  }
  if (FIXTURE) key += ":long";
  if (queryTheme()) key += `:${queryTheme()}`;
  screen.dataset.card = key;
  if (key === lastKey) return;
  const first = !lastKey;
  lastKey = key;
  const run = () => {
    paintCard(card);
    fitVisibleText();
    const fit = () => requestAnimationFrame(() => fitVisibleText());
    fit();
    document.fonts?.ready.then(fit).catch(() => {});
  };
  if (first || !transitionsOn()) {
    screen.classList.remove("is-leaving", "is-entering");
    run();
    return;
  }
  const token = ++transitionToken;
  screen.classList.add("is-leaving");
  window.setTimeout(() => {
    if (token !== transitionToken) return;
    run();
    screen.classList.remove("is-leaving");
    screen.classList.add("is-entering");
    window.setTimeout(() => {
      if (token === transitionToken) screen.classList.remove("is-entering");
    }, 720);
  }, 420);
}

function alignVideo(startedAt) {
  if (!wallVideo.duration || !Number.isFinite(wallVideo.duration)) return;
  const elapsed = ((Date.now() - Number(startedAt)) / 1000) % wallVideo.duration;
  if (Math.abs(wallVideo.currentTime - elapsed) > 0.35) wallVideo.currentTime = elapsed;
}

function seekIntoCard(card) {
  if (card?.stream) return;
  const duration = wallVideo.duration;
  if (!Number.isFinite(duration) || duration < 20) return;
  let start = Number(card.startSec);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (start < 0.05) return;
  const cap = Math.max(0, duration - Math.min(20, duration * 0.05));
  try {
    wallVideo.currentTime = Math.min(Math.max(0, start), cap);
  } catch {
    // A failed seek stays at the current frame. The server assigns another clip.
  }
}

let stallTimer = null;
let reportedVideoId = "";

function clearStall() {
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = null;
  wallVideo.ontimeupdate = null;
  wallVideo.onerror = null;
}

function reportVideo(card, reason) {
  const id = String(card?.id || "");
  if (!id || id === reportedVideoId) return;
  reportedVideoId = id;
  fetch("/api/media/failure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, reason, title: card.title || "" }),
  }).catch(() => {});
}

function armStall(card) {
  clearStall();
  let last = wallVideo.currentTime || 0;
  let lastMove = Date.now();
  const started = Date.now();
  wallVideo.ontimeupdate = () => {
    if (Math.abs(wallVideo.currentTime - last) > 0.25) {
      last = wallVideo.currentTime;
      lastMove = Date.now();
    }
  };
  wallVideo.onerror = () => {
    reportVideo(card, "failed");
  };
  stallTimer = setInterval(() => {
    if (wallVideo.ended && card.loop) return;
    const quiet = Date.now() - lastMove;
    const waiting = Date.now() - started;
    if (quiet < 4500 || waiting < 4500) return;
    if (wallVideo.readyState >= 3 && Math.abs(wallVideo.currentTime - last) > 0.25) return;
    reportVideo(card, "stalled");
    clearStall();
  }, 1000);
}

function showVideo(card) {
  setMode("video");
  stopVideo();
  teardownPresent();
  clearSync();
  const fallback = document.getElementById("video-fallback");
  if (!card?.url || card.empty) {
    stopWallVideo();
    wallVideo.hidden = true;
    if (fallback) fallback.hidden = true;
    if (card?.id && card.id !== "preview" && card.id !== "empty") reportVideo(card, "failed");
    return;
  }
  wallVideo.hidden = false;
  wallVideo.style.opacity = "1";
  if (fallback) fallback.hidden = true;
  const slots = card.slots || [SLOT];
  const primary = String(slots[0] || SLOT);
  if (card.mode === "span") {
    const count = Math.max(1, slots.length);
    const index = Math.max(0, slots.map(String).indexOf(String(SLOT)));
    wallVideo.classList.add("span");
    wallVideo.style.width = `${count * 100}%`;
    wallVideo.style.transform = `translateX(-${(index * 100) / count}%)`;
  } else {
    wallVideo.classList.remove("span");
    wallVideo.style.width = "100%";
    wallVideo.style.transform = "";
  }
  wallVideo.loop = Boolean(card.loop);
  wallVideo.muted = true;
  wallVideo.defaultMuted = true;
  wallVideo.playsInline = true;
  if (wallVideo.getAttribute("src") !== card.url) wallVideo.src = card.url;
  if (card.mode === "card") {
    wallVideo.onloadedmetadata = () => seekIntoCard(card);
    armStall(card);
  } else if (card.startedAt) {
    const seek = () => alignVideo(card.startedAt);
    wallVideo.onloadedmetadata = seek;
    syncTimer = setInterval(seek, 2000);
  }
  wallVideo.onended = () => {
    if (card.mode === "card" || card.loop) return;
    if (String(SLOT) !== primary) return;
    fetch("/api/media/next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId: card.id }),
    }).catch(() => {});
  };
  const startPlayback = () => {
    wallVideo.play().catch(() => {
      wallVideo.muted = true;
      wallVideo.play().catch(() => reportVideo(card, "failed"));
    });
  };
  startPlayback();
}

function shareLines() {
  const share = payload?.share;
  if (!share) return "Open /present on this WiFi";
  const host = share.hosts?.[0] || location.hostname;
  const protocol = share.secure ? "https" : "http";
  return `${protocol}://${host}:${share.port}${share.path || "/present"}`;
}

function sendPresent(message) {
  const data = JSON.stringify(message);
  if (socket && socket.readyState === 1) socket.send(data);
  else pendingMessages.push(data);
}

function flushPending() {
  if (!socket || socket.readyState !== 1) return;
  while (pendingMessages.length) socket.send(pendingMessages.shift());
}

function helloViewer(presentation) {
  if (helloId === presentation.id) return;
  helloId = presentation.id;
  sendPresent({ type: "present-hello", presentationId: presentation.id, role: "viewer" });
}

function openViewerPeer(presentation) {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.close();
  }
  iceQueue = [];
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    presentVideo.srcObject = stream;
    presentVideo.hidden = false;
    presentWaiting.hidden = true;
    presentVideo.play().catch(() => {});
    sendPresent({ type: "present-live", presentationId: presentation.id });
  };
  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendPresent({
      type: "present-signal",
      presentationId: presentation.id,
      payload: { kind: "ice", candidate: event.candidate },
    });
  };
}

async function acceptSignal(presentation, signal) {
  if (!signal) return;
  if (signal.kind === "offer" && signal.sdp) {
    openViewerPeer(presentation);
    await pc.setRemoteDescription(signal.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendPresent({
      type: "present-signal",
      presentationId: presentation.id,
      payload: { kind: "answer", sdp: pc.localDescription },
    });
    const queued = iceQueue;
    iceQueue = [];
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }
    return;
  }
  if (signal.kind === "ice" && signal.candidate) {
    if (!pc || !pc.remoteDescription) {
      iceQueue.push(signal.candidate);
      return;
    }
    await pc.addIceCandidate(signal.candidate).catch(() => {});
  }
}

function showPresent(presentation) {
  setMode("present");
  stopVideo();
  stopWallVideo();
  const same = shownPresentId === presentation.id && shownPresentSource === presentation.source;
  if (!same) {
    if (pc) {
      pc.close();
      pc = null;
    }
    iceQueue = [];
    helloId = null;
    presentVideo.srcObject = null;
    presentVideo.hidden = true;
    presentImage.hidden = true;
    presentImage.removeAttribute("src");
    presentFrame.hidden = true;
    presentFrame.src = "about:blank";
    shownPresentId = presentation.id;
    shownPresentSource = presentation.source;
  }

  if (presentation.source === "webrtc") {
    presentFrame.hidden = true;
    presentImage.hidden = true;
    presentHeading.textContent = "Share to this screen";
    presentCode.hidden = false;
    presentCode.textContent = presentation.code || "";
    presentInstructions.textContent = `On a laptop or Android phone, open\n${shareLines()}\nand enter this code.\n\niPhone and iPad cannot share from Safari. Use AirPlay and choose ${payload?.airplay?.serverName || "Pinball Land"}.`;
    if (!presentVideo.srcObject) presentWaiting.hidden = false;
    helloViewer(presentation);
    return;
  }

  if (presentation.source === "airplay") {
    presentImage.hidden = true;
    presentFrame.hidden = true;
    presentCode.hidden = true;
    const name = payload?.airplay?.serverName || "Pinball Land";
    if (presentation.helper?.capture) {
      presentHeading.textContent = "AirPlay on every screen";
      presentInstructions.textContent = "Copying the mirror from the first TV.";
      if (mirrorId !== presentation.id || !presentVideo.srcObject) {
        mirrorId = presentation.id;
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then((stream) => {
          presentVideo.srcObject = stream;
          presentVideo.muted = true;
          presentVideo.hidden = false;
          presentWaiting.hidden = true;
          presentVideo.play().catch(() => {});
        }).catch(() => {
          presentWaiting.hidden = false;
          presentVideo.hidden = true;
          presentInstructions.textContent = "This screen copies the AirPlay picture. The first TV still has the real mirror.";
        });
      }
      return;
    }
    if (presentVideo.srcObject) {
      for (const track of presentVideo.srcObject.getTracks()) track.stop();
      presentVideo.srcObject = null;
    }
    mirrorId = null;
    presentVideo.hidden = true;
    presentWaiting.hidden = false;
    presentHeading.textContent = presentation.helper?.ok === false ? "AirPlay needs setup" : "AirPlay to this screen";
    presentInstructions.textContent = presentation.helper?.ok === false
      ? `${presentation.helper.error || "UxPlay is not running."}\n\nRun scripts\\install-airplay-windows.ps1 on the wall PC. Steps are in PRESENTING.md.`
      : `On iPhone or Mac: Control Center → Screen Mirroring → ${name}.\n\nThis screen switches over when the mirror connects.`;
    return;
  }

  presentWaiting.hidden = true;
  presentCode.hidden = true;
  presentVideo.hidden = true;
  if (presentation.source === "file" && presentation.fileKind === "image") {
    presentFrame.hidden = true;
    presentFrame.src = "about:blank";
    presentImage.hidden = false;
    presentImage.alt = presentation.fileName || "Presentation";
    if (presentation.fileUrl && presentImage.getAttribute("src") !== presentation.fileUrl) {
      presentImage.src = presentation.fileUrl;
    }
    return;
  }

  const frameUrl = presentation.source === "url" ? presentation.url : presentation.fileUrl;
  presentImage.hidden = true;
  presentImage.removeAttribute("src");
  presentFrame.hidden = false;
  if (frameUrl && presentFrame.src !== new URL(frameUrl, location.href).href) {
    presentFrame.src = frameUrl;
  }
}

function showClock() {
  setMode("clock");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  paintClock();
}

function paintClock() {
  const now = new Date(Date.now() - clockSkew);
  clockTime.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const event = (payload?.state?.leaderboards || []).find((board) => board.kind !== "machine");
  setFit(clockEvent, FIXTURE ? LONG_TEXT : (event?.name || payload?.guest?.eventName || "Tonight"));
}

const PIN_CAP = 12;

function pinHash(text, salt) {
  let h = 2166136261 ^ (Number(salt) || 0);
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function visiblePinPhotos(photos) {
  const list = Array.isArray(photos) ? photos : [];
  if (list.length <= PIN_CAP) return list;
  const start = Math.floor(Math.max(0, Date.now() - clockSkew) / 12000) % list.length;
  const shown = [];
  for (let i = 0; i < PIN_CAP; i += 1) shown.push(list[(start + i) % list.length]);
  return shown;
}

function pinCardBox(cardW, cardH, tilt, scale) {
  const rad = Math.abs(tilt) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    w: (cardW * Math.abs(cos) + cardH * Math.abs(sin)) * scale,
    h: (cardW * Math.abs(sin) + cardH * Math.abs(cos)) * scale,
  };
}

function layoutPins(count, width, height) {
  const n = Math.max(1, count);
  const cols = n === 1 ? 1 : n <= 2 ? 2 : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const margin = 10;
  const usableW = Math.max(40, width - margin * 2);
  const usableH = Math.max(40, height - margin * 2);
  const overlap = n >= 8 ? 0.14 : n >= 4 ? 0.08 : 0;
  const cellW = usableW / cols;
  const cellH = usableH / rows;
  const ratio = 1.36;
  let cardW = Math.min(cellW * (1 + overlap), n === 1 ? 460 : 340);
  let cardH = cardW * ratio;
  if (cardH > cellH * (1 + overlap)) {
    cardH = cellH * (1 + overlap);
    cardW = cardH / ratio;
  }
  const worst = pinCardBox(cardW, cardH, 8, 1.05);
  if (worst.w > usableW) {
    cardW *= usableW / worst.w;
    cardH = cardW * ratio;
  }
  if (worst.h > usableH && cardH > 0) {
    const fitted = pinCardBox(cardW, cardH, 8, 1.05);
    const scaleDown = Math.min(1, usableH / fitted.h, usableW / fitted.w);
    cardW *= scaleDown;
    cardH = cardW * ratio;
  }
  return { cols, rows, margin, cellW, cellH, cardW, cardH };
}

function placePhotos(target, card) {
  let photos = payload?.guest?.photos || [];
  const requested = Number.parseInt(params.get("pins") || "", 10);
  if (Number.isFinite(requested) && requested > 0) {
    const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const names = ["Alex Parra", "Jordan Hale", "Sam Okonkwo", "Riley Chen", "Morgan Blake"];
    photos = Array.from({ length: requested }, (_, i) => ({
      id: `pin-${i}`,
      url: photos[i % Math.max(photos.length, 1)]?.url || pixel,
      caption: i % 2 === 0 ? "High score on Oz" : "Friday night",
      guestName: names[i % names.length],
      createdAt: Date.now() - i * 60000,
    }));
  } else if (FIXTURE) {
    const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    photos = [0, 1, 2].map((i) => ({
      id: `fixture-${i}`,
      url: photos[i]?.url || pixel,
      caption: LONG_TEXT,
      guestName: "Guest",
      createdAt: 0,
    }));
  }
  if (target === collageGrid) {
    target.replaceChildren();
    photos.forEach((photo) => {
      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = photo.caption || "Guest photo";
      target.append(img);
    });
    return;
  }
  const shown = visiblePinPhotos(photos);
  const width = Math.max(1, target.clientWidth || window.innerWidth);
  const height = Math.max(1, target.clientHeight || window.innerHeight);
  const layout = layoutPins(shown.length, width, height);
  target.replaceChildren();
  shown.forEach((photo, index) => {
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    const seed = pinHash(photo.id, 1);
    const seedB = pinHash(photo.id, 2);
    const seedC = pinHash(photo.id, 3);
    const tilt = (seed < 0.5 ? -1 : 1) * (4 + seedB * 4);
    const scale = 0.94 + seedC * 0.1;
    const box = pinCardBox(layout.cardW, layout.cardH, tilt, scale);
    const jitterX = (seed - 0.5) * layout.cellW * 0.12;
    const jitterY = (seedB - 0.5) * layout.cellH * 0.1;
    let cx = layout.margin + layout.cellW * (col + 0.5) + jitterX;
    let cy = layout.margin + layout.cellH * (row + 0.5) + jitterY;
    const halfW = box.w / 2 + 8;
    const halfH = box.h / 2 + 8;
    cx = Math.min(width - halfW, Math.max(halfW, cx));
    cy = Math.min(height - halfH, Math.max(halfH, cy));
    const el = document.createElement("article");
    el.className = `pin-card${Date.now() - Number(photo.createdAt) < 20000 ? " is-new" : ""}`;
    el.style.width = `${layout.cardW}px`;
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    el.style.zIndex = String(10 + Math.round(seedC * 20));
    el.style.setProperty("--tilt", `${tilt.toFixed(2)}deg`);
    el.style.setProperty("--pin-scale", scale.toFixed(3));
    el.style.setProperty("--drift-x", `${((seed - 0.5) * 8).toFixed(1)}px`);
    el.style.setProperty("--drift-y", `${((seedB - 0.5) * 6).toFixed(1)}px`);
    el.style.transform = `translate(-50%, -50%) rotate(${tilt.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = photo.caption || "Guest photo";
    const cap = document.createElement("span");
    cap.setAttribute("data-fit", "2");
    const taken = Number(photo.createdAt) ? new Date(Number(photo.createdAt)).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) : "";
    const caption = [photo.guestName, photo.caption].filter(Boolean).join(" · ");
    setFit(cap, FIXTURE && !(Number.isFinite(requested) && requested > 0) ? LONG_TEXT : [taken, caption].filter(Boolean).join(" · "));
    el.append(img, cap);
    target.append(el);
  });
}

function showPinboard(card) {
  setMode("pinboard");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  placePhotos(pinWall, card);
}

function showCollage() {
  setMode("collage");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  placePhotos(collageGrid, { span: false });
}

function showYoutube(card) {
  setMode("youtube");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  const frame = document.createElement("iframe");
  frame.src = card.embed || "";
  frame.title = card.title || "Video";
  frame.allow = "autoplay; encrypted-media; picture-in-picture";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  youtubePanel.replaceChildren(frame);
  frame.addEventListener("load", () => {
    frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
  });
}

window.addEventListener("message", (event) => {
  let host = "";
  try { host = new URL(event.origin).hostname; } catch { return; }
  if (!["www.youtube.com", "youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"].includes(host)) return;
  let data = event.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return; }
  }
  const code = Number(data?.info);
  const ended = data?.event === "onStateChange" && code === 0;
  const failed = data?.event === "onError" && [100, 101, 150].includes(code);
  if (!ended && !failed) return;
  if (String(SLOT) !== "1" && payload?.playback?.slots?.[0] && String(payload.playback.slots[0]) !== String(SLOT)) return;
  fetch("/api/media/next", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
});

let clockSkew = 0;

function paintMotion(dt) {
  if (!motionCanvas) return;
  const ctx = motionCanvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  if (motionCanvas.width !== Math.round(width * dpr) || motionCanvas.height !== Math.round(height * dpr)) {
    motionCanvas.width = Math.round(width * dpr);
    motionCanvas.height = Math.round(height * dpr);
    motionCanvas.style.width = `${width}px`;
    motionCanvas.style.height = `${height}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (SHOT || !window.PinballMotion || payload?.motion === "off") {
    ctx.clearRect(0, 0, width, height);
    motionField = null;
    return;
  }
  const theme = queryTheme() || payload?.state?.theme || "pinnacle";
  const sync = payload?.motionSync || {};
  const seed = sync.seed || 1;
  if (!motionField || motionTheme !== theme || motionField.seed !== seed) {
    motionTheme = theme;
    motionField = window.PinballMotion.createField(theme, seed);
  }
  const epoch = Number(sync.epoch) || 0;
  const elapsed = Math.max(0, (Date.now() - clockSkew - epoch) / 1000);
  window.PinballMotion.drawField(ctx, motionField, width, height, { slot: slotIndex(), elapsed });
}

function motionFrame(ts) {
  const dt = lastFrame ? (ts - lastFrame) / 1000 : 0.016;
  lastFrame = ts;
  paintMotion(dt);
  requestAnimationFrame(motionFrame);
}

function tick() {
  if (!payload) return;
  applyTheme(payload.state?.theme);
  renderCard(resolveCard());
  if (screen.dataset.mode === "board") paintBoardArt();
  if (screen.dataset.mode === "clock") paintClock();
  if (screen.dataset.mode === "clock" || FIXTURE) requestAnimationFrame(() => fitVisibleText());
}

function applyPayload(next) {
  payload = next;
  clockSkew = Date.now() - (Number(next?.serverNow) || Date.now());
  lastKey = "";
  tick();
}

if (new URLSearchParams(location.search).has("shot")) {
  document.documentElement.classList.add("is-shot");
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener("open", () => {
    helloId = null;
    flushPending();
    const presentation = payload?.presentations?.[SLOT];
    if (presentation?.source === "webrtc") helloViewer(presentation);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      applyPayload(message);
      return;
    }
    if (message.type === "present-signal" && message.payload) {
      const presentation = payload?.presentations?.[SLOT];
      if (presentation?.source === "webrtc" && presentation.id === message.presentationId) {
        signalChain = signalChain.then(() => acceptSignal(presentation, message.payload)).catch(() => {});
      }
    }
  });
  socket.addEventListener("close", () => {
    socket = null;
    setTimeout(connect, 1000);
  });
}

fetch("/api/state")
  .then((res) => res.json())
  .then(applyPayload)
  .catch(() => showOff());

connect();
setInterval(tick, 250);
requestAnimationFrame(motionFrame);
if (document.fonts?.ready) {
  document.fonts.ready.then(() => fitVisibleText()).catch(() => {});
}
