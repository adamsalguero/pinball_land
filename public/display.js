const SLOT = location.pathname.split("/").pop();

const screen = document.getElementById("screen");
const offPanel = document.getElementById("off");
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

let payload = null;
let lastKey = "";

function formatScore(score) {
  return Number(score || 0).toLocaleString("en-US");
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "halloween" ? "halloween" : "pinnacle";
}

function setMode(mode) {
  screen.dataset.mode = mode;
  offPanel.hidden = mode !== "off";
  logoPanel.hidden = mode !== "logo";
  amenityPanel.hidden = mode !== "amenity";
  boardPanel.hidden = mode !== "board";
}

function showOff() {
  setMode("off");
  stopVideo();
}

function showLogo(url, label) {
  setMode("logo");
  stopVideo();
  logoImage.alt = label;
  logoFallback.textContent = `${label} — add the file in public/logos`;
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
  amenityHeadline.textContent = amenity?.headline || "";
  amenityBody.textContent = amenity?.body || "";
  if (amenity?.eventTypes) {
    amenityTypes.hidden = false;
    amenityTypes.textContent = amenity.eventTypes;
  } else {
    amenityTypes.hidden = true;
    amenityTypes.textContent = "";
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
  boardEmpty.hidden = rows.length > 0;
  boardRows.hidden = rows.length === 0;
  rows.forEach((row, index) => {
    const li = document.createElement("li");
    li.className = "board-row";

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 1).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = row.name || "—";

    const score = document.createElement("span");
    score.className = "score";
    score.textContent = formatScore(row.score);

    li.append(rank, name, score);
    boardRows.append(li);
  });
}

function showBoard(board) {
  setMode("board");
  boardTitle.textContent = board?.name || "Leaderboard";
  const meta = [board?.manufacturer, board?.year].filter(Boolean).join(" · ");
  boardMeta.hidden = !meta;
  boardMeta.textContent = meta;
  renderRows(board?.rows || []);

  const isMachine = board?.kind === "machine";
  const videoUrl = isMachine && board?.videoUrl && /\.(mp4|webm|ogg)(\?|$)/i.test(board.videoUrl)
    ? board.videoUrl
    : null;
  const artUrl = isMachine ? board?.artUrl : null;
  boardPanel.classList.toggle("has-art", Boolean(isMachine && (artUrl || videoUrl)));

  if (videoUrl) {
    machineArtWrap.hidden = false;
    machineArt.hidden = true;
    machineVideo.hidden = false;
    if (machineVideo.getAttribute("src") !== videoUrl) {
      machineVideo.src = videoUrl;
    }
    machineVideo.play().catch(() => {});
  } else if (artUrl) {
    stopVideo();
    machineArtWrap.hidden = false;
    machineArt.hidden = false;
    machineArt.alt = board.name || "Machine art";
    if (machineArt.src !== artUrl) machineArt.src = artUrl;
  } else {
    stopVideo();
    machineArtWrap.hidden = true;
    machineArt.hidden = true;
    machineArt.removeAttribute("src");
  }
}

function currentTick(startedAt, intervalSec, now = Date.now()) {
  const ms = Math.max(3, Number(intervalSec) || 14) * 1000;
  const start = Number(startedAt);
  const origin = Number.isFinite(start) ? start : now;
  return Math.floor(Math.max(0, now - origin) / ms);
}

function cardForSlot(playlist, tick, slotIndex) {
  if (!playlist?.length) return null;
  const n = playlist.length;
  return playlist[(((tick + slotIndex) % n) + n) % n];
}

function slotIndex() {
  const n = Number.parseInt(SLOT, 10);
  return Number.isFinite(n) && n > 0 ? n - 1 : 0;
}

function cardFromSlot(state) {
  const slot = state.slots?.[SLOT];
  if (!slot || slot.content === "off") return { type: "off" };
  if (slot.content === "pinnacle") return { type: "logo", key: "pinnacle" };
  if (slot.content === "pinball-land") return { type: "logo", key: "pinball-land" };
  if (slot.content === "amenity-arcade") return { type: "amenity", id: "arcade" };
  if (slot.content === "amenity-oasis") return { type: "amenity", id: "oasis" };
  if (slot.content === "amenity-events") return { type: "amenity", id: "events" };
  if (["photos", "arcade", "bar", "pool", "collage", "venue"].includes(slot.content)) {
    return { type: "amenity", id: slot.content === "pool" || slot.content === "bar" ? "oasis" : "arcade" };
  }
  return { type: "leaderboard", id: slot.leaderboardId };
}

function resolveCard() {
  const state = payload?.state;
  if (!state || state.blackout) return { type: "off" };
  if (state.rotation?.enabled) {
    return cardForSlot(payload.playlist, currentTick(state.rotation.startedAt, state.rotation.intervalSec), slotIndex())
      || { type: "off" };
  }
  return cardFromSlot(state);
}

function cardKey(card) {
  if (!card) return "off";
  if (card.type === "logo") return `logo:${card.key}`;
  if (card.type === "amenity") return `amenity:${card.id}`;
  if (card.type === "leaderboard") return `board:${card.id}`;
  return card.type || "off";
}

function boardKey(board) {
  if (!board) return "board:missing";
  const rows = (board.rows || []).map((row) => `${row.id}:${row.score}:${row.name}`).join(",");
  return `board:${board.id}:${board.artUrl || ""}:${board.videoUrl || ""}:${rows}`;
}

function renderCard(card) {
  const logos = payload?.logos || {};
  const photos = payload?.photos || {};
  const amenities = payload?.amenities || [];
  let key = cardKey(card);
  if (card?.type === "leaderboard") {
    const board = (payload.state.leaderboards || []).find((item) => item.id === card.id);
    key = boardKey(board);
  }
  if (key === lastKey) {
    return;
  }
  lastKey = key;

  if (!card || card.type === "off") {
    showOff();
    return;
  }
  if (card.type === "logo") {
    const label = card.key === "pinnacle"
      ? "Pinnacle Group Financial Services"
      : "Pinnacle Entertainment Center";
    showLogo(logos[card.key], card.label || label);
    return;
  }
  if (card.type === "amenity") {
    const amenity = amenities.find((item) => item.id === card.id);
    showAmenity(amenity, photos);
    return;
  }
  const board = (payload.state.leaderboards || []).find((item) => item.id === card.id);
  showBoard(board);
}

function tick() {
  if (!payload) return;
  applyTheme(payload.state?.theme);
  renderCard(resolveCard());
}

function applyPayload(next) {
  payload = next;
  lastKey = "";
  tick();
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      applyPayload(message);
    }
  });
  socket.addEventListener("close", () => {
    setTimeout(connect, 1000);
  });
}

fetch("/api/state")
  .then((res) => res.json())
  .then(applyPayload)
  .catch(() => showOff());

connect();
setInterval(tick, 250);
