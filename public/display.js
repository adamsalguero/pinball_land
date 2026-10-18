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
let wallVideo = document.getElementById("wall-video");
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
  return !SHOT;
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
  enforceFirstLargest();
}

function enforceFirstLargest() {
  const first = document.querySelector(".podium-card.place-1 .who");
  const rest = [...document.querySelectorAll(".podium-card.place-2 .who, .podium-card.place-3 .who")];
  if (!first || !rest.length || first.closest("[hidden]")) return;
  const size = (el) => parseFloat(el.style.fontSize) || parseFloat(getComputedStyle(el).fontSize) || 0;
  let firstSize = size(first);
  const smallest = Math.min(...rest.map(size));
  if (smallest > 0 && firstSize > smallest / 0.6) {
    firstSize = Math.floor(smallest / 0.6);
    first.style.fontSize = `${firstSize}px`;
  }
  for (const el of rest) {
    if (size(el) > firstSize - 1) el.style.fontSize = `${Math.max(Math.round(firstSize * 0.6), firstSize - 4)}px`;
  }
}

function scoreNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value ?? "").replace(/[,_\s]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortScoreRows(rows) {
  return [...(rows || [])].sort((a, b) => scoreNumber(b.score) - scoreNumber(a.score) || String(a.name || "").localeCompare(String(b.name || "")));
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
  document.documentElement.classList.toggle("particles-under", mode === "pinboard");
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

let swapping = false;
let heldClip = null;
let failedClipIds = new Set();
let recoveryHold = null;
let blobFailures = 0;
let showToken = 0;
let lastProgressAt = 0;
const clipBlobs = new Map();

function clearSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  clearLoadTimer();
  clearStall();
}

function releaseVideoElement(video) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.preload = "none";
  try { video.load(); } catch { /* decoder already released */ }
}

function stopWallVideo() {
  swapping = true;
  clearSync();
  wallVideo.onended = null;
  wallVideo.onloadedmetadata = null;
  wallVideo.onprogress = null;
  wallVideo.onseeked = null;
  wallVideo.oncanplay = null;
  wallVideo.onpause = null;
  wallVideo.onerror = null;
  wallVideo.onwaiting = null;
  wallVideo.onstalled = null;
  wallVideo.onsuspend = null;
  wallVideo.ontimeupdate = null;
  releaseVideoElement(wallVideo);
  wallVideo.preload = "none";
  wallVideo.classList.remove("span", "is-ready");
  wallVideo.style.width = "";
  wallVideo.style.transform = "";
  delete wallVideo.dataset.playId;
  delete wallVideo.dataset.ready;
  if (wallVideo.isConnected) wallVideo.remove();
  const hold = document.getElementById("video-hold");
  if (hold) {
    hold.hidden = true;
    hold.classList.remove("is-fading");
  }
  videoPanel.classList.remove("is-staging");
  swapping = false;
}

function replaceWallVideo() {
  const fresh = document.createElement("video");
  fresh.id = "wall-video";
  fresh.muted = true;
  fresh.defaultMuted = true;
  fresh.playsInline = true;
  fresh.setAttribute("playsinline", "");
  fresh.preload = "auto";
  const previous = wallVideo;
  previous.onended = null;
  previous.onloadedmetadata = null;
  previous.onprogress = null;
  previous.onseeked = null;
  previous.oncanplay = null;
  previous.onpause = null;
  previous.onerror = null;
  previous.onwaiting = null;
  previous.onstalled = null;
  previous.onsuspend = null;
  previous.ontimeupdate = null;
  releaseVideoElement(previous);
  previous.preload = "none";
  if (previous.isConnected) previous.replaceWith(fresh);
  else videoPanel.append(fresh);
  wallVideo = fresh;
}

function ensureWallVideo() {
  if (!videoPanel.contains(wallVideo)) videoPanel.append(wallVideo);
  wallVideo.preload = "auto";
  wallVideo.muted = true;
  wallVideo.defaultMuted = true;
  wallVideo.playsInline = true;
  wallVideo.setAttribute("playsinline", "");
}

function holdFrame() {
  const hold = document.getElementById("video-hold");
  if (!hold || wallVideo.readyState < 2 || !wallVideo.videoWidth) return;
  try {
    hold.width = wallVideo.videoWidth;
    hold.height = wallVideo.videoHeight;
    hold.getContext("2d").drawImage(wallVideo, 0, 0, hold.width, hold.height);
    hold.classList.remove("is-fading");
    hold.hidden = false;
  } catch {
    // A blank frame is better than blocking the next clip.
  }
}

function releaseHold() {
  const hold = document.getElementById("video-hold");
  if (!hold || hold.hidden) return;
  hold.classList.add("is-fading");
  window.setTimeout(() => {
    hold.hidden = true;
    hold.classList.remove("is-fading");
  }, 320);
}

function stageWallVideo() {
  ensureWallVideo();
  videoPanel.hidden = false;
  videoPanel.classList.add("is-staging");
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
  setMode("off");
  stopVideo();
  stopWallVideo();
  teardownPresent();
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

function paintEventTypes(text) {
  const items = String(text || "").split("|").map((item) => item.trim()).filter(Boolean);
  amenityTypes.replaceChildren();
  amenityTypes.removeAttribute("data-fit");
  delete amenityTypes.dataset.full;
  if (!items.length) {
    amenityTypes.classList.remove("is-chips");
    amenityTypes.hidden = true;
    return;
  }
  amenityTypes.classList.add("is-chips");
  amenityTypes.hidden = false;
  items.forEach((item) => {
    const chip = document.createElement("span");
    chip.className = "amenity-chip";
    chip.textContent = item;
    amenityTypes.append(chip);
  });
}

function showAmenity(amenity, photos) {
  setMode("amenity");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  setFit(amenityHeadline, FIXTURE ? `${amenity?.headline || "Amenities"} ${LONG_TEXT}` : (amenity?.headline || ""));
  setFit(amenityBody, FIXTURE ? LONG_TEXT : (amenity?.body || ""));
  if (FIXTURE) {
    amenityTypes.classList.remove("is-chips");
    amenityTypes.hidden = false;
    amenityTypes.replaceChildren();
    setFit(amenityTypes, LONG_TEXT);
  } else if (amenity?.eventTypes) {
    paintEventTypes(amenity.eventTypes);
  } else {
    amenityTypes.classList.remove("is-chips");
    amenityTypes.replaceChildren();
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
  releaseVideoElement(machineVideo);
  machineVideo.hidden = true;
}

function renderRows(rows) {
  boardRows.replaceChildren();
  podium.replaceChildren();
  const ranked = sortScoreRows(rows);
  const top = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  podium.hidden = top.length === 0;
  boardEmpty.hidden = rows.length > 0;
  boardRows.hidden = rest.length === 0 && top.length > 0 ? true : rows.length === 0;
  if (top.length) {
    const order = [top[1], top[0], top[2]].filter(Boolean);
    order.forEach((row) => {
      const place = top.indexOf(row) + 1;
      const card = document.createElement("article");
      card.className = `podium-card place-${place}`;
      card.innerHTML = `<p class="place">${place === 1 ? "First" : place === 2 ? "Second" : "Third"}</p><span class="who" data-fit="2" data-fit-full="1"></span><span class="points" data-fit="1" data-fit-full="1"></span>`;
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
let failedArt = new Set();
let failedArtBoard = "";

function boardArtList(board) {
  if (!board || board.kind !== "machine") return [];
  const urls = Array.isArray(board.artUrls) ? board.artUrls.filter(Boolean) : [];
  if (urls.length) return urls;
  return board.artUrl ? [board.artUrl] : [];
}

function paintBoardArt() {
  const board = shownBoard;
  const boardKey = `${board?.id || ""}:${board?.name || ""}`;
  if (failedArtBoard !== boardKey) {
    failedArtBoard = boardKey;
    failedArt = new Set();
  }
  const fallback = document.getElementById("machine-art-fallback");
  const isMachine = board?.kind === "machine";
  const urls = boardArtList(board).filter((url) => !failedArt.has(url));
  const showPlaceholder = () => {
    machineVideo.hidden = true;
    machineArt.hidden = true;
    machineArt.onerror = null;
    machineArt.onload = null;
    machineArt.removeAttribute("src");
    delete machineArt.dataset.src;
    machineArt.alt = "";
    if (!isMachine) {
      boardPanel.classList.remove("has-art");
      machineArtWrap.hidden = true;
      if (fallback) fallback.hidden = true;
      return;
    }
    boardPanel.classList.add("has-art");
    machineArtWrap.hidden = false;
    if (fallback) {
      fallback.hidden = false;
      fallback.textContent = board?.name || "Leaderboard";
    }
  };
  if (!urls.length) {
    showPlaceholder();
    return;
  }
  const cursor = Math.floor(Math.max(0, Date.now() - clockSkew) / 8000);
  const artUrl = urls[cursor % urls.length];
  boardPanel.classList.add("has-art");
  machineVideo.hidden = true;
  machineArtWrap.hidden = false;
  if (fallback) fallback.hidden = true;
  machineArt.alt = "";
  machineArt.onerror = () => {
    const failed = machineArt.dataset.src;
    if (failed) failedArt.add(failed);
    machineArt.onerror = null;
    machineArt.hidden = true;
    machineArt.removeAttribute("src");
    paintBoardArt();
  };
  machineArt.onload = () => {
    if (machineArt.dataset.src !== artUrl) return;
    machineArt.hidden = false;
    machineArt.style.opacity = "1";
    machineArt.alt = board?.name || "Machine art";
    if (fallback) fallback.hidden = true;
  };
  if (machineArt.dataset.src !== artUrl) {
    machineArt.style.opacity = "0";
    machineArt.hidden = true;
    machineArt.dataset.src = artUrl;
    machineArt.src = artUrl;
  } else if (machineArt.complete && machineArt.naturalWidth > 0) {
    machineArt.hidden = false;
    machineArt.alt = board?.name || "Machine art";
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
  if (FIXTURE && params.get("art")) {
    const artMode = params.get("art");
    const catalogs = {
      1: ["/photos/arcade", "/photos/oasis"],
      skip: ["/photos/not-a-real-photo", "/photos/arcade"],
      bad: ["/photos/not-a-real-photo", "/photos/also-missing"],
    };
    shownBoard = {
      kind: "machine",
      name: "The Wizard of Oz (75th Anniversary Edition)",
      artUrls: catalogs[artMode] || catalogs["1"],
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
  if (content === "clock") return { type: "clock" };
  if (content === "video") return pinnedVideo();
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
  if (payload.rotationPlan) {
    const planned = payload.rotationPlan[SLOT] || payload.rotationPlan[String(SLOT)] || null;
    if (recoveryHold) {
      const stillBad = planned?.type === "video" && planned.id === recoveryHold.avoidId;
      if (stillBad) return { ...recoveryHold.card, span: false };
      recoveryHold = null;
    }
    const pinned = payload.layout?.[SLOT]?.content === "video";
    if (heldClip) {
      if (pinned) {
        if (planned?.type === "video" && planned.playId === heldClip.serverPlayId) {
          return { ...heldClip.card, span: false };
        }
        heldClip = null;
        failedClipIds = new Set();
      } else if (heldClip.tick === serverTick()) {
        return { ...heldClip.card, span: false };
      } else {
        heldClip = null;
        failedClipIds = new Set();
      }
    }
    if (planned) return { ...planned, span: false };
    return { type: "off" };
  }
  const layout = payload.layout?.[SLOT];
  if (layout && layout.content && layout.content !== "rotation") {
    const pinned = cardFromContent(layout.content, layout.leaderboardId);
    if (pinned) return pinned;
  }
  return cardFromSlot(state);
}

function decorate(card) {
  if (!card || card.type === "off") return card || { type: "off" };
  if (card.type === "amenity" && (card.cycle || card.id === "amenities")) {
    return { ...card, type: "amenity", id: cyclePick(AMENITY_ORDER, AMENITY_DWELL_MS, slotIndex()) };
  }
  if (card.type === "logo" && !card.key) {
    const key = slotIndex() % 2 === 0 ? "pinnacle" : "pinball-land";
    return { ...card, key, cycle: false };
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
    return `video:${card.id}:${card.mode}:${card.startSec || ""}:${card.playId ?? ""}:${card.startedAt || ""}:${(card.slots || []).join(",")}`;
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

function clearFades() {
  for (const el of screen.querySelectorAll(".is-fading-out")) {
    el.classList.remove("is-fading-out");
    el.style.removeProperty("opacity");
    if (el.hidden === false && screen.dataset.mode) {
      const active = {
        present: presentPanel,
        video: videoPanel,
        logo: logoPanel,
        amenity: amenityPanel,
        board: boardPanel,
        clock: clockPanel,
        pinboard: pinboardPanel,
        collage: collagePanel,
        youtube: youtubePanel,
      }[screen.dataset.mode];
      if (el !== active) el.hidden = true;
    }
  }
  screen.classList.remove("is-entering");
}

function fadeOutgoing(outgoing) {
  if (!transitionsOn()) return;
  const token = ++transitionToken;
  screen.classList.add("is-entering");
  for (const el of outgoing) {
    if (!el.hidden) continue;
    el.hidden = false;
    el.classList.add("is-fading-out");
    requestAnimationFrame(() => {
      if (token === transitionToken) el.style.opacity = "0";
    });
  }
  window.setTimeout(() => {
    if (token === transitionToken) clearFades();
  }, 360);
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
  clearFades();
  const outgoing = [...screen.querySelectorAll(".panel")].filter((el) => !el.hidden);
  const finish = () => {
    fitVisibleText();
    const fit = () => requestAnimationFrame(() => fitVisibleText());
    fit();
    document.fonts?.ready.then(fit).catch(() => {});
    if (!first) fadeOutgoing(outgoing);
  };
  if (card?.type === "video" && card.url && !card.empty) {
    showVideo(card, () => {
      if (lastKey !== key) return;
      finish();
    });
    return;
  }
  paintCard(card);
  finish();
}

function retainClipBlobs(keep) {
  for (const [url, entry] of clipBlobs) {
    if (keep.has(url)) continue;
    entry.dropped = true;
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
    clipBlobs.delete(url);
  }
}

function noteBlob(card, entry) {
  if (!entry || entry.logged) return;
  entry.logged = true;
  reportVideo(card, "blob-loaded", { bytes: entry.bytes, ms: entry.ms, src: entry.mediaUrl });
}

function loadClipBlob(mediaUrl) {
  const existing = clipBlobs.get(mediaUrl);
  if (existing?.blobUrl) return Promise.resolve(existing);
  if (existing?.promise) return existing.promise;
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const slot = { mediaUrl, dropped: false, promise: null };
  slot.promise = fetch(mediaUrl, { cache: "no-store" }).then(async (res) => {
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started);
    if (slot.dropped) return null;
    const entry = { mediaUrl, blobUrl: URL.createObjectURL(blob), bytes: blob.size, ms };
    clipBlobs.set(mediaUrl, entry);
    return entry;
  }).catch((err) => {
    if (clipBlobs.get(mediaUrl) === slot) clipBlobs.delete(mediaUrl);
    throw err;
  });
  clipBlobs.set(mediaUrl, slot);
  return slot.promise;
}

let stallTimer = null;
let loadTimer = null;

function clearLoadTimer() {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = null;
}
const reportedEvents = new Set();
const warmedAssets = new Set();

function reportVideo(card, eventName, extra = {}) {
  const id = String(card?.id || "");
  const event = String(eventName || "event");
  const seen = `${id}:${event}`;
  const always = event === "ended" || event === "give-up" || event === "stall-timeout" || event === "error" || event === "progress" || event === "blob-loaded" || event === "play-start" || event === "replay";
  if (!always && reportedEvents.has(seen)) return;
  if (!always) reportedEvents.add(seen);
  const err = wallVideo.error;
  sendSocket({
    type: "media-failure",
    id,
    slot: SLOT,
    event,
    reason: event,
    title: card?.title || "",
    code: err ? err.code : null,
    networkState: wallVideo.networkState,
    readyState: wallVideo.readyState,
    currentTime: wallVideo.currentTime,
    src: extra.src || wallVideo.dataset.mediaUrl || card?.url || "",
    bytes: Number.isFinite(Number(extra.bytes)) ? Number(extra.bytes) : undefined,
    ms: Number.isFinite(Number(extra.ms)) ? Number(extra.ms) : undefined,
    offset: Number.isFinite(Number(extra.offset)) ? Number(extra.offset) : undefined,
    failedIds: [...failedClipIds],
  });
}

function clearStall() {
  stallGeneration += 1;
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = null;
  wallVideo.ontimeupdate = null;
  wallVideo.onerror = null;
  wallVideo.onwaiting = null;
  wallVideo.onstalled = null;
  wallVideo.onsuspend = null;
  wallVideo.onpause = null;
}

function otherScreenClipIds() {
  const ids = new Set();
  const plan = payload?.rotationPlan || {};
  for (const slot of ["1", "2", "3"]) {
    if (String(slot) === String(SLOT)) continue;
    const card = plan[slot];
    if (card?.type === "video" && card.id) ids.add(card.id);
  }
  return ids;
}

function holdClip(card) {
  const planned = payload?.rotationPlan?.[SLOT] || payload?.rotationPlan?.[String(SLOT)] || null;
  heldClip = {
    tick: serverTick(),
    serverPlayId: planned?.playId,
    card,
  };
}

function uniqueVideos(exceptId) {
  const busy = otherScreenClipIds();
  return (payload?.playlist || []).filter((item) => (
    item?.type === "video" && item.url && !item.empty && item.id !== exceptId && !busy.has(item.id) && !failedClipIds.has(item.id)
  ));
}

function showRecoveryCard(card) {
  if (!card) return null;
  if (card.type === "video" && card.url && !card.empty) {
    const salt = `${serverTick()}:${failedClipIds.size}:${card.id}`;
    const advanced = {
      ...card,
      mode: "card",
      loop: false,
      startSec: card.startSec || window.PinballRotation.videoStartSec(card.id, salt, card.durationSec),
      playId: card.playId || `${card.id}:${salt}`,
    };
    holdClip(advanced);
    lastKey = cardKey(decorate(advanced));
    showVideo(advanced);
    return advanced;
  }
  heldClip = null;
  stopWallVideo();
  const fallback = document.getElementById("video-fallback");
  if (fallback) fallback.hidden = true;
  const shown = decorate(card);
  paintCard(shown);
  lastKey = cardKey(shown);
  return shown;
}

function failClip(card, eventName) {
  clearStall();
  reportVideo(card, eventName);
  blobFailures = 0;
  failedClipIds.add(card.id);
  const videos = uniqueVideos(card?.id);
  if (!videos.length) {
    failedClipIds = new Set([card?.id].filter(Boolean));
    reportVideo(card, "give-up");
    const shown = showRecoveryCard(window.PinballRotation.replacementFor(payload?.rotationPlan, SLOT, payload?.playlist, {
      failedIds: [...failedClipIds, ...otherScreenClipIds()],
      salt: `${SLOT}:give-up`,
    }));
    recoveryHold = shown ? { avoidId: card?.id || "", card: shown } : null;
    return;
  }
  const next = videos[window.PinballRotation.hash32(`${card.id}:${failedClipIds.size}`) % videos.length];
  const salt = `${serverTick()}:${failedClipIds.size}:${next.id}`;
  const advanced = {
    ...next,
    mode: "card",
    loop: false,
    startSec: window.PinballRotation.videoStartSec(next.id, salt, next.durationSec),
    playId: `${next.id}:${salt}`,
  };
  holdClip(advanced);
  lastKey = cardKey(decorate(advanced));
  showVideo(advanced);
}

function seekTargetFor(card) {
  const duration = Number(wallVideo.duration) || 0;
  let target = Number(card?.startSec) || 0;
  if (!(target > 0.5) && duration > 1 && window.PinballRotation?.videoStartSec) {
    target = window.PinballRotation.videoStartSec(card.id, card.playId || card.id, duration);
  }
  if (duration && target > duration - 0.4) target = Math.max(0, duration * 0.5);
  return target;
}

function onClipEnded(card) {
  const pinned = payload?.layout?.[SLOT]?.content === "video";
  if (!pinned) {
    const target = seekTargetFor(card);
    blobFailures = 0;
    wallVideo.onseeked = () => {
      wallVideo.onseeked = null;
      const pending = wallVideo.play();
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
      armStall(card);
    };
    try {
      wallVideo.currentTime = target;
    } catch {
      armStall(card);
    }
    return;
  }
  reportVideo(card, "ended");
  heldClip = null;
  failedClipIds = new Set();
  recoveryHold = null;
  blobFailures = 0;
}

let stallGeneration = 0;

function armStall(card) {
  clearStall();
  const generation = stallGeneration;
  let lastSample = wallVideo.currentTime || 0;
  let lastMove = Date.now();
  let lastCheck = 0;
  let sawMove = false;
  const note = (eventName) => {
    if (swapping || wallVideo.dataset.ready !== "1") return;
    reportVideo(card, eventName);
  };
  const noteProgress = () => {
    if (wallVideo.seeking) return;
    const time = wallVideo.currentTime || 0;
    if (!sawMove) {
      sawMove = true;
      lastSample = time;
      lastMove = Date.now();
      return;
    }
    if (Math.abs(time - lastSample) >= 0.5) {
      lastSample = time;
      lastMove = Date.now();
      blobFailures = 0;
    }
  };
  wallVideo.ontimeupdate = noteProgress;
  wallVideo.onerror = () => {
    if (swapping) return;
    failClip(card, "error");
  };
  wallVideo.onwaiting = () => note("waiting");
  wallVideo.onstalled = () => note("stalled");
  wallVideo.onsuspend = () => note("suspend");
  const check = () => {
    if (generation !== stallGeneration || !wallVideo.isConnected || swapping) return;
    const now = Date.now();
    if (now - lastCheck < 500) return;
    lastCheck = now;
    if (now - lastProgressAt >= 60000 && wallVideo.dataset.ready === "1") {
      lastProgressAt = now;
      reportVideo(card, "progress");
    }
    if (wallVideo.paused || wallVideo.ended || wallVideo.seeking) {
      lastMove = now;
      lastSample = wallVideo.currentTime || lastSample;
      return;
    }
    noteProgress();
    const quiet = now - lastMove;
    const action = window.PinballPlayback.blobWatchdog({
      quietMs: quiet,
      paused: wallVideo.paused,
      ended: wallVideo.ended,
      failures: blobFailures,
    });
    screen.dataset.quiet = String(Math.round(quiet));
    screen.dataset.stall = action;
    if (action === "replay") replayBlob(card, wallVideo.currentTime);
    else if (action === "next") failClip(card, "stall-timeout");
  };
  stallTimer = setInterval(check, 1000);
}

function startOffset(card, explicit) {
  if (Number.isFinite(Number(explicit))) return Math.max(0, Number(explicit));
  if (card?.mode && card.mode !== "card" && card.startedAt) {
    const duration = Number(wallVideo.duration) || 0;
    if (duration > 0) return ((Date.now() - Number(card.startedAt)) / 1000) % duration;
  }
  return seekTargetFor(card);
}

function beginPlayback(card, playToken, offset, onReady) {
  if (wallVideo.dataset.playId !== playToken) return;
  clearLoadTimer();
  wallVideo.dataset.ready = "1";
  videoPanel.classList.remove("is-staging");
  wallVideo.classList.add("is-ready");
  setMode("video");
  releaseHold();
  const fallback = document.getElementById("video-fallback");
  if (fallback) fallback.hidden = true;
  if (!lastProgressAt) lastProgressAt = Date.now();
  reportVideo(card, "play-start", { offset: wallVideo.currentTime || offset || 0 });
  const pending = wallVideo.play();
  if (pending && typeof pending.catch === "function") pending.catch(() => {});
  armStall(card);
  if (onReady) onReady();
}

function armClip(card, { playToken, startAt, onReady }) {
  const slots = card.slots || [SLOT];
  const primary = String(slots[0] || SLOT);
  wallVideo.onloadedmetadata = () => {
    if (wallVideo.dataset.playId !== playToken) return;
    const target = startOffset(card, startAt);
    const go = () => beginPlayback(card, playToken, target, onReady);
    if (!(target > 0.25)) {
      go();
      return;
    }
    wallVideo.onseeked = () => {
      wallVideo.onseeked = null;
      go();
    };
    try {
      wallVideo.currentTime = target;
    } catch {
      go();
    }
  };
  wallVideo.onended = () => {
    clearStall();
    if (card.loop && card.mode !== "card") return;
    if (card.mode && card.mode !== "card") {
      if (String(SLOT) !== primary) return;
      sendSocket({ type: "media-next", videoId: card.id });
      return;
    }
    onClipEnded(card);
  };
  wallVideo.onerror = () => {
    if (swapping || wallVideo.dataset.playId !== playToken) return;
    failClip(card, "error");
  };
}

function replayBlob(card, atTime) {
  const blobUrl = wallVideo.dataset.blobUrl;
  const mediaUrl = wallVideo.dataset.mediaUrl || card?.url || "";
  if (!blobUrl) {
    failClip(card, "stall-timeout");
    return;
  }
  blobFailures += 1;
  const playToken = String(card?.playId || card?.id || "");
  reportVideo(card, "replay", { offset: Number(atTime) || 0 });
  clearStall();
  swapping = true;
  replaceWallVideo();
  wallVideo.dataset.playId = playToken;
  wallVideo.dataset.mediaUrl = mediaUrl;
  wallVideo.dataset.blobUrl = blobUrl;
  wallVideo.dataset.ready = "0";
  wallVideo.preload = "auto";
  wallVideo.muted = true;
  wallVideo.defaultMuted = true;
  wallVideo.playsInline = true;
  armClip(card, { playToken, startAt: Number(atTime) || 0 });
  wallVideo.src = blobUrl;
  swapping = false;
}

async function showVideo(card, onReady) {
  const playToken = String(card?.playId || card?.id || "");
  if (card?.url && wallVideo.dataset.playId === playToken && wallVideo.dataset.blobUrl && !wallVideo.ended && wallVideo.dataset.ready === "1") {
    ensureWallVideo();
    if (screen.dataset.mode !== "video") setMode("video");
    if (onReady) onReady();
    return;
  }
  stopVideo();
  teardownPresent();
  clearSync();
  const fallback = document.getElementById("video-fallback");
  if (!card?.url || card.empty) {
    stopWallVideo();
    if (fallback) fallback.hidden = true;
    setMode("video");
    if (!card?.empty && card?.id && card.id !== "preview") reportVideo(card, "failed");
    if (onReady) onReady();
    return;
  }
  const token = ++showToken;
  clearLoadTimer();
  if (wallVideo.dataset.ready === "1") holdFrame();
  stageWallVideo();
  wallVideo.dataset.playId = playToken;
  wallVideo.dataset.ready = "0";
  wallVideo.dataset.mediaUrl = card.url;
  loadTimer = window.setTimeout(() => {
    if (token !== showToken || wallVideo.dataset.ready === "1") return;
    failClip(card, "stall-timeout");
  }, 20000);
  let entry;
  try {
    entry = await loadClipBlob(card.url);
  } catch {
    if (token !== showToken) return;
    failClip(card, "error");
    return;
  }
  if (!entry || token !== showToken || wallVideo.dataset.playId !== playToken) return;
  noteBlob(card, entry);
  swapping = true;
  wallVideo.onloadedmetadata = null;
  wallVideo.onended = null;
  wallVideo.oncanplay = null;
  wallVideo.onseeked = null;
  wallVideo.onerror = null;
  releaseVideoElement(wallVideo);
  wallVideo.classList.remove("is-ready");
  if (card.mode === "span") {
    const count = Math.max(1, card.slots?.length || 1);
    const index = Math.max(0, (card.slots || [SLOT]).map(String).indexOf(String(SLOT)));
    wallVideo.classList.add("span");
    wallVideo.style.width = `${count * 100}%`;
    wallVideo.style.transform = `translateX(-${(index * 100) / count}%)`;
  } else {
    wallVideo.classList.remove("span");
    wallVideo.style.width = "100%";
    wallVideo.style.transform = "";
  }
  wallVideo.loop = card.mode && card.mode !== "card" ? Boolean(card.loop) : false;
  wallVideo.muted = true;
  wallVideo.defaultMuted = true;
  wallVideo.playsInline = true;
  wallVideo.preload = "auto";
  wallVideo.dataset.playId = playToken;
  wallVideo.dataset.mediaUrl = card.url;
  wallVideo.dataset.blobUrl = entry.blobUrl;
  wallVideo.dataset.ready = "0";
  armClip(card, { playToken, onReady });
  wallVideo.src = entry.blobUrl;
  swapping = false;
}

function warmAsset(url) {
  if (!url || warmedAssets.has(url)) return;
  warmedAssets.add(url);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
}

function preloadUpcoming() {
  if (!payload || !window.PinballRotation) return;
  const logos = payload.logos || {};
  warmAsset(logos.pinnacle);
  warmAsset(logos["pinball-land"]);
  for (const amenity of payload.amenities || []) {
    if (amenity?.photo) warmAsset(payload.photos?.[amenity.photo]);
  }
  const timing = payload.rotationTiming || {};
  const min = Number(timing.minInterval) || 10;
  const requested = Number(timing.intervalSec) || Number(payload.state?.rotation?.intervalSec) || 30;
  const interval = window.PinballRotation.clampInterval(requested, min);
  const startedAt = Number(payload.state?.rotation?.startedAt) || 0;
  const nextAt = startedAt + (serverTick() + 1) * interval * 1000;
  const plan = window.PinballRotation.planRotation(payload.playlist || [], {
    startedAt,
    intervalSec: interval,
    minInterval: min,
    screenCount: Number(payload.displays?.count) || 3,
    layout: payload.layout || {},
    now: nextAt + 5,
  });
  const next = plan?.[SLOT] || plan?.[String(SLOT)];
  if (next?.type === "logo") warmAsset(logos[next.key]);
  const keep = new Set();
  if (wallVideo.dataset.mediaUrl) keep.add(wallVideo.dataset.mediaUrl);
  if (next?.type === "video" && next.url && !next.empty) {
    keep.add(next.url);
    loadClipBlob(next.url).then((entry) => noteBlob(next, entry)).catch(() => {});
  }
  retainClipBlobs(keep);
}

function shareLines() {
  const share = payload?.share;
  if (!share) return "Open /present on this WiFi";
  const host = share.hosts?.[0] || location.hostname;
  const protocol = share.secure ? "https" : "http";
  return `${protocol}://${host}:${share.port}${share.path || "/present"}`;
}

function sendSocket(message) {
  const data = JSON.stringify(message);
  if (socket && socket.readyState === 1) socket.send(data);
  else pendingMessages.push(data);
}

function sendPresent(message) {
  sendSocket(message);
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

function themeSlogan() {
  const theme = queryTheme() || payload?.state?.theme || "pinnacle";
  const slogans = payload?.slogans || {};
  if (Object.prototype.hasOwnProperty.call(slogans, theme)) return String(slogans[theme] || "");
  if (theme === "halloween") return "Happy Halloween!";
  if (theme === "christmas") return "Merry Christmas!";
  return "";
}

function paintClock() {
  const now = new Date(Date.now() - clockSkew);
  clockTime.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const slogan = FIXTURE ? LONG_TEXT : themeSlogan();
  setFit(clockEvent, slogan);
  clockEvent.hidden = !slogan;
}

const PIN_CAP = 12;

function pinHash(text, salt) {
  let h = 2166136261 ^ (Number(salt) || 0);
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
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

function rectsOverlap(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}

function overlapRatio(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const area = x * y;
  const denom = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  return area / denom;
}

function pinTilt(id) {
  const dir = pinHash(id, 11);
  const amount = pinHash(id, 29);
  const sign = dir < 0.5 ? -1 : 1;
  return sign * (1 + amount * 2);
}

function cardParts(cx, cy, cardW, cardH, tilt) {
  const box = pinCardBox(cardW, cardH, tilt, 1);
  const full = { x: cx - box.w / 2, y: cy - box.h / 2, w: box.w, h: box.h };
  const captionH = Math.max(44, Math.min(64, cardH * 0.24));
  return {
    full,
    caption: { x: full.x, y: full.y + full.h - captionH, w: full.w, h: captionH },
    photo: { x: full.x, y: full.y, w: full.w, h: Math.max(20, full.h - captionH) },
  };
}

function qrHole(wall) {
  const qr = document.querySelector(".pin-qr");
  if (!qr || !wall) return null;
  const wallBox = wall.getBoundingClientRect();
  const box = qr.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  return {
    x: box.left - wallBox.left - 16,
    y: box.top - wallBox.top - 16,
    w: box.width + 32,
    h: box.height + 32,
  };
}

function spotFits(parts, placed, width, height, qr) {
  if (parts.full.x < 4 || parts.full.y < 4) return false;
  if (parts.full.x + parts.full.w > width - 4 || parts.full.y + parts.full.h > height - 4) return false;
  if (qr && rectsOverlap(parts.full, qr, 0)) return false;
  for (const other of placed) {
    if (rectsOverlap(parts.caption, other.full, 6)) return false;
    if (rectsOverlap(other.caption, parts.full, 6)) return false;
    if (overlapRatio(parts.photo, other.photoBox) > 0.16) return false;
  }
  return true;
}

function pinCardHeight(cardW) {
  return cardW + 58;
}

function tryPinGrid(photos, cols, rows, cardW, width, height, qr) {
  const cardH = pinCardHeight(cardW);
  const specs = photos.map((photo) => {
    const tilt = pinTilt(photo.id);
    return {
      photo,
      tilt,
      cardW,
      cardH,
      box: pinCardBox(cardW, cardH, tilt, 1),
      z: 8 + Math.round(pinHash(photo.id, 9) * 40),
    };
  });
  const cellW = Math.max(...specs.map((item) => item.box.w));
  const cellH = Math.max(...specs.map((item) => item.box.h));
  // Gap stays wider than the caption pad plus the jitter below, for every id window.
  const gap = 18;
  const gridW = cols * cellW + (cols - 1) * gap;
  const gridH = rows * cellH + (rows - 1) * gap;
  const minX = 4;
  const minY = 4;
  const maxX = width - 4 - gridW;
  const maxY = height - 4 - gridH;
  if (maxX < minX - 0.5 || maxY < minY - 0.5) return null;
  const origins = [
    { x: (minX + maxX) / 2, y: minY + (maxY - minY) * 0.22 },
  ];
  if (qr) {
    origins.push(
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: minX, y: maxY },
      { x: Math.min(maxX, Math.max(minX, qr.x - gridW - 8)), y: minY },
    );
  }
  for (const origin of origins) {
    const placed = [];
    let fits = true;
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const col = index % cols;
      const row = Math.floor(index / cols);
      const jx = (pinHash(spec.photo.id, 21) - 0.5) * 4;
      const jy = (pinHash(spec.photo.id, 22) - 0.5) * 4;
      const left = origin.x + col * (cellW + gap) + (cellW - spec.box.w) / 2 + jx;
      const top = origin.y + row * (cellH + gap) + (cellH - spec.box.h) / 2 + jy;
      const parts = cardParts(left + spec.box.w / 2, top + spec.box.h / 2, cardW, cardH, spec.tilt);
      if (!spotFits(parts, placed, width, height, qr)) {
        fits = false;
        break;
      }
      placed.push({
        photo: spec.photo,
        cx: left + spec.box.w / 2,
        cy: top + spec.box.h / 2,
        tilt: spec.tilt,
        cardW,
        cardH,
        z: spec.z,
        full: parts.full,
        caption: parts.caption,
        photoBox: parts.photo,
      });
    }
    if (fits) return placed;
  }
  return null;
}

function scatterPins(photos, width, height, qr) {
  const n = photos.length;
  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    let lo = 96;
    let hi = Math.min(width * 0.86, height * 0.86, 640);
    let placed = null;
    for (let step = 0; step < 12; step += 1) {
      const mid = (lo + hi) / 2;
      const attempt = tryPinGrid(photos, cols, rows, mid, width, height, qr);
      if (attempt) {
        placed = attempt;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    if (placed && (!best || placed[0].cardW > best[0].cardW)) best = placed;
  }
  if (best) return best;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cardW = Math.max(72, Math.min((width - 32) / cols / 1.12, (height - 32) / rows / 1.45));
  const fitted = tryPinGrid(photos, cols, rows, cardW, width, height, null);
  if (fitted) return fitted;
  const cardH = pinCardHeight(cardW);
  return photos.map((photo, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      photo,
      cx: 16 + cardW * (col + 0.55),
      cy: 16 + cardH * (row + 0.55),
      tilt: pinTilt(photo.id),
      cardW,
      cardH,
      z: 10 + index,
    };
  });
}

function placePhotos(target, card) {
  let photos = payload?.guest?.photos || [];
  const requested = Number.parseInt(params.get("pins") || "", 10);
  if (Number.isFinite(requested) && requested > 0) {
    const samples = ["/photos/arcade", "/photos/oasis"];
    const names = ["Adam Salguero", "Jordan Hale", "Sam Okonkwo", "Riley Chen", "Morgan Blake"];
    photos = Array.from({ length: requested }, (_, i) => ({
      id: `pin-${i}`,
      url: samples[i % samples.length],
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
  const placed = scatterPins(shown, width, height, qrHole(target));
  target.replaceChildren();
  placed.forEach((spot) => {
    const photo = spot.photo;
    const el = document.createElement("article");
    el.className = `pin-card${Date.now() - Number(photo.createdAt) < 20000 ? " is-new" : ""}`;
    el.style.width = `${spot.cardW}px`;
    el.style.left = `${spot.cx}px`;
    el.style.top = `${spot.cy}px`;
    el.style.zIndex = String(spot.z);
    el.style.setProperty("--tilt", `${spot.tilt.toFixed(2)}deg`);
    el.style.transform = `translate(-50%, -50%) rotate(${spot.tilt.toFixed(2)}deg)`;
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = photo.caption || "Guest photo";
    const cap = document.createElement("span");
    const fixtureCaption = FIXTURE && !(Number.isFinite(requested) && requested > 0);
    const taken = Number(photo.createdAt) ? new Date(Number(photo.createdAt)).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) : "";
    const caption = [photo.guestName, photo.caption].filter(Boolean).join(" · ");
    const line = fixtureCaption ? LONG_TEXT : [taken, caption].filter(Boolean).join(" · ");
    cap.textContent = line;
    if (fixtureCaption) {
      cap.dataset.full = line;
      cap.setAttribute("data-fit", "3");
    }
    el.append(img, cap);
    target.append(el);
  });
}

let qrDayShown = null;

function refreshGuestQr() {
  const qr = document.querySelector("#pin-qr");
  const card = document.querySelector(".pin-qr");
  if (!qr || !card) return;
  if (payload?.guest?.pinboard === false) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const day = payload?.guest?.qrDay || "";
  if (qrDayShown === null) {
    qrDayShown = day;
    return;
  }
  if (!day || day === qrDayShown) return;
  qrDayShown = day;
  const next = `/api/guest-qr?d=${encodeURIComponent(day)}`;
  if (qr.getAttribute("src") !== next) qr.src = next;
}

function showPinboard(card) {
  setMode("pinboard");
  stopVideo();
  stopWallVideo();
  teardownPresent();
  refreshGuestQr();
  const place = () => placePhotos(pinWall, card);
  place();
  const qr = document.querySelector("#pin-qr");
  if (qr && !qr.complete) {
    qr.addEventListener("load", () => {
      place();
      if (FIXTURE) requestAnimationFrame(() => fitVisibleText());
    }, { once: true });
  }
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
  sendSocket({ type: "media-next", videoId: payload?.playback?.videoId || "" });
});

let clockSkew = 0;

function serverTick() {
  const timing = payload?.rotationTiming || {};
  const interval = Number(timing.intervalSec) || Number(payload?.state?.rotation?.intervalSec) || 30;
  const min = Number(timing.minInterval) || 10;
  if (!window.PinballRotation?.currentTick) return 0;
  return window.PinballRotation.currentTick(
    payload?.state?.rotation?.startedAt,
    interval,
    Date.now() - clockSkew,
    min,
  );
}

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
  if (SHOT || !window.PinballMotion) {
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
  const avoid = [];
  if (screen.dataset.mode === "amenity") {
    const copy = document.querySelector(".amenity-copy");
    if (copy) {
      const box = copy.getBoundingClientRect();
      const pad = 16;
      if (box.width > 8 && box.height > 8) {
        avoid.push({ x: box.left - pad, y: box.top - pad, w: box.width + pad * 2, h: box.height + pad * 2 });
      }
    }
  }
  window.PinballMotion.drawField(ctx, motionField, width, height, { slot: slotIndex(), elapsed, avoid });
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
  refreshGuestQr();
  preloadUpcoming();
  renderCard(resolveCard());
  if (screen.dataset.mode === "board") paintBoardArt();
  if (screen.dataset.mode === "clock") paintClock();
  if (screen.dataset.mode === "clock" || FIXTURE) requestAnimationFrame(() => fitVisibleText());
}

function applyPayload(next) {
  payload = next;
  clockSkew = Date.now() - (Number(next?.serverNow) || Date.now());
  tick();
}

if (new URLSearchParams(location.search).has("shot")) {
  document.documentElement.classList.add("is-shot");
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // State, clip failures, and playlist advance use this socket. The only HTTP
  // from a display after startup is short media ranges and images (logos, art, QR).
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
