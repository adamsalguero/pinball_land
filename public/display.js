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
const presentPanel = document.getElementById("present");
const presentWaiting = document.getElementById("present-waiting");
const presentHeading = document.getElementById("present-heading");
const presentCode = document.getElementById("present-code");
const presentInstructions = document.getElementById("present-instructions");
const presentVideo = document.getElementById("present-video");
const presentImage = document.getElementById("present-image");
const presentFrame = document.getElementById("present-frame");

let payload = null;
let lastKey = "";
let socket = null;
let pc = null;
let iceQueue = [];
let signalChain = Promise.resolve();
let shownPresentId = null;
let shownPresentSource = null;
let helloId = null;
const pendingMessages = [];

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
  presentPanel.hidden = mode !== "present";
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
  teardownPresent();
}

function showLogo(url, label) {
  setMode("logo");
  stopVideo();
  teardownPresent();
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
  teardownPresent();
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
  teardownPresent();
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

function cardFromContent(content, leaderboardId) {
  if (!content || content === "off" || content === "rotation") return { type: "off" };
  if (content === "pinnacle") return { type: "logo", key: "pinnacle" };
  if (content === "pinball-land") return { type: "logo", key: "pinball-land" };
  if (content === "amenity-arcade") return { type: "amenity", id: "arcade" };
  if (content === "amenity-oasis") return { type: "amenity", id: "oasis" };
  if (content === "amenity-events") return { type: "amenity", id: "events" };
  if (content === "leaderboard") return { type: "leaderboard", id: leaderboardId };
  return { type: "off" };
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
  const presentation = payload.presentations?.[SLOT];
  if (presentation?.source) return { type: "present", presentation };
  const layout = payload.layout?.[SLOT];
  if (layout && layout.content && layout.content !== "rotation") {
    return cardFromContent(layout.content, layout.leaderboardId);
  }
  const stagger = Number.isInteger(layout?.staggerIndex) ? layout.staggerIndex : slotIndex();
  if (state.rotation?.enabled) {
    return cardForSlot(payload.playlist, currentTick(state.rotation.startedAt, state.rotation.intervalSec), stagger)
      || { type: "off" };
  }
  return cardFromSlot(state);
}

function cardKey(card) {
  if (!card) return "off";
  if (card.type === "present") {
    const item = card.presentation;
    return `present:${item.id}:${item.source}:${item.url || ""}:${item.fileUrl || ""}:${item.code || ""}:${item.helper?.ok}:${item.helper?.error || ""}`;
  }
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
  if (card.type === "present") {
    showPresent(card.presentation);
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
    presentVideo.hidden = true;
    presentImage.hidden = true;
    presentFrame.hidden = true;
    presentCode.hidden = true;
    presentWaiting.hidden = false;
    const name = payload?.airplay?.serverName || "Pinball Land";
    presentHeading.textContent = presentation.helper?.ok === false ? "AirPlay needs setup" : "AirPlay to this screen";
    presentInstructions.textContent = presentation.helper?.ok === false
      ? `${presentation.helper.error || "UxPlay is not running."}\n\nInstall the helper on the wall PC, then try again. Steps are in PRESENTING.md.`
      : `On iPhone or Mac: Control Center → Screen Mirroring → ${name}.\n\nThis screen stays up until the mirror connects.`;
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
