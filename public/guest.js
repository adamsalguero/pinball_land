const still = document.getElementById("still");
const takeFile = document.getElementById("take-file");
const chooseFile = document.getElementById("choose-file");
const post = document.getElementById("post");
const status = document.getElementById("post-status");
const feed = document.getElementById("feed");
const feedEmpty = document.getElementById("feed-empty");
const scores = document.getElementById("scores");
const picker = document.getElementById("machine-picker");

let blob = null;
let previewUrl = "";
let boards = [];

function tap() {
  if (navigator.vibrate) navigator.vibrate(10);
}

function applyTheme(theme) {
  const name = theme === "halloween" || theme === "christmas" ? theme : "pinnacle";
  document.documentElement.dataset.theme = name;
  const color = name === "halloween" ? "#100c09" : name === "christmas" ? "#07140f" : "#62006E";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = color;
}

function showTab(name) {
  tap();
  for (const button of document.querySelectorAll("[data-guest-tab]")) {
    button.classList.toggle("active", button.dataset.guestTab === name);
  }
  for (const panel of document.querySelectorAll("[data-guest-panel]")) {
    panel.hidden = panel.dataset.guestPanel !== name;
  }
  if (name === "board") loadFeed();
  if (name === "scores") loadScores();
}

function useBlob(next) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  blob = next;
  previewUrl = next ? URL.createObjectURL(next) : "";
  still.src = previewUrl;
  still.hidden = !next;
  post.disabled = !next;
}

document.getElementById("take-photo").addEventListener("click", () => {
  tap();
  takeFile.click();
});
document.getElementById("choose-photo").addEventListener("click", () => {
  tap();
  chooseFile.click();
});
takeFile.addEventListener("change", () => {
  const file = takeFile.files?.[0];
  if (file) useBlob(file);
});
chooseFile.addEventListener("change", () => {
  const file = chooseFile.files?.[0];
  if (file) useBlob(file);
});

async function uploadOne(file) {
  const res = await fetch("/api/guest-photos", {
    method: "POST",
    headers: {
      "content-type": file.type || "image/jpeg",
      "x-caption": encodeURIComponent(document.getElementById("caption").value.trim()),
      "x-guest-name": encodeURIComponent(document.getElementById("guest-name").value.trim()),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data.photo;
}

post.addEventListener("click", async () => {
  tap();
  post.disabled = true;
  status.textContent = "Sending…";
  try {
    const photo = await uploadOne(blob);
    status.textContent = photo.status === "pending"
      ? "Posted. It shows on the wall after the host approves it."
      : "Posted. It is on the pinboard.";
    useBlob(null);
    takeFile.value = "";
    chooseFile.value = "";
    loadFeed();
  } catch (err) {
    status.textContent = err.message;
    post.disabled = false;
  }
});

function appleHandheld() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function homeScreen() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function openPhotoLightbox(url, filename) {
  const box = document.getElementById("photo-lightbox");
  const img = document.getElementById("photo-lightbox-img");
  img.src = url;
  img.alt = filename || "Guest photo";
  box.dataset.photoUrl = url;
  box.dataset.photoName = filename || "photo.jpg";
  box.hidden = false;
}

async function shareOrKeep(url, filename) {
  const name = filename || "photo.jpg";
  const ios = appleHandheld() || homeScreen();
  if (ios && typeof navigator.share === "function") {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.ok) {
        const blob = await res.blob();
        const file = new File([blob], name, { type: blob.type || "image/jpeg" });
        const payload = { files: [file], title: "Pinball Land" };
        if (typeof navigator.canShare !== "function" || navigator.canShare(payload)) {
          await navigator.share(payload);
          return;
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  openPhotoLightbox(url, name);
  if (!homeScreen()) {
    const opened = window.open(url, "_blank", "noopener");
    if (opened) return;
  }
}

document.getElementById("photo-lightbox-download").addEventListener("click", () => {
  const box = document.getElementById("photo-lightbox");
  shareOrKeep(box.dataset.photoUrl, box.dataset.photoName);
});

document.getElementById("photo-lightbox-close").addEventListener("click", () => {
  document.getElementById("photo-lightbox").hidden = true;
});

function when(stamp) {
  const n = Number(stamp);
  if (!n) return "";
  return new Date(n).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadFeed() {
  try {
  const res = await fetch("/api/guest-photos/feed");
  if (!res.ok) return;
  const data = await res.json();
  feed.replaceChildren();
  const photos = data.photos || [];
  feedEmpty.hidden = photos.length > 0;
  for (const photo of photos.slice().reverse()) {
    const card = document.createElement("article");
    card.className = "card";
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = photo.caption || "Guest photo";
    const copy = document.createElement("p");
    copy.textContent = [when(photo.createdAt), photo.guestName, photo.caption].filter(Boolean).join(" · ") || "On the wall";
    img.addEventListener("click", () => openPhotoLightbox(photo.url, `${photo.id}.jpg`));
    card.append(img, copy);
    feed.append(card);
  }
  } catch (err) {
    console.error(err);
  }
}

function selectedBoard() {
  return boards.find((board) => board.id === picker.value) || boards[0] || null;
}

function renderScores() {
  scores.replaceChildren();
  const board = selectedBoard();
  if (!board) {
    const empty = document.createElement("p");
    empty.className = "status";
    empty.textContent = "Machines show up here once they are on a board.";
    scores.append(empty);
    return;
  }
  for (const row of board.rows || []) {
    const line = document.createElement("div");
    line.className = "score-card";
    const name = document.createElement("span");
    name.textContent = row.name || "—";
    const points = document.createElement("strong");
    points.textContent = Number(row.score || 0).toLocaleString("en-US");
    line.append(name, points);
    scores.append(line);
  }
}

function renderPicker() {
  const current = picker.value;
  picker.replaceChildren();
  for (const board of boards) {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.name;
    picker.append(option);
  }
  if (boards.some((board) => board.id === current)) picker.value = current;
  picker.hidden = boards.length === 0;
}

function scoreBoardFromUrl() {
  const id = new URLSearchParams(location.search).get("board") || "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
}

let scoreFormScrolled = false;

function maybeScrollScoreForm() {
  if (scoreFormScrolled) return;
  const params = new URLSearchParams(location.search);
  if (params.get("tab") !== "scores" && !params.get("board")) return;
  scoreFormScrolled = true;
  document.getElementById("score-form")?.scrollIntoView({ block: "nearest" });
}

async function loadScores() {
  const res = await fetch("/api/guest");
  const data = await res.json();
  applyTheme(data.state?.theme);
  boards = (data.state?.leaderboards || []).filter((board) => board.kind === "machine");
  renderPicker();
  const wanted = scoreBoardFromUrl();
  if (wanted && boards.some((board) => board.id === wanted)) picker.value = wanted;
  renderScores();
  maybeScrollScoreForm();
}

picker.addEventListener("change", renderScores);

document.getElementById("score-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const note = document.getElementById("score-status");
  const board = selectedBoard();
  if (!board) {
    note.textContent = "Pick a machine first.";
    return;
  }
  const name = document.getElementById("score-name").value.trim();
  const score = document.getElementById("score-value").value.replace(/,/g, "");
  const photo = document.getElementById("score-photo").files?.[0];
  note.textContent = "Sending…";
  try {
    let res;
    if (photo) {
      res = await fetch("/api/scores", {
        method: "POST",
        headers: {
          "content-type": photo.type || "image/jpeg",
          "x-board-id": encodeURIComponent(board.id),
          "x-name": encodeURIComponent(name),
          "x-score": score,
        },
        body: photo,
      });
    } else {
      res = await fetch("/api/scores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardId: board.id, name, score }),
      });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not send that score");
    note.textContent = data.submission?.status === "approved"
      ? "Sent. It's on the board."
      : "Sent. It shows on the board after the host approves it.";
    event.target.reset();
    if (data.submission?.status === "approved") loadScores();
  } catch (err) {
    note.textContent = err.message;
  }
});

for (const button of document.querySelectorAll("[data-guest-tab]")) {
  button.addEventListener("click", () => showTab(button.dataset.guestTab));
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function applyGuestAccess(data) {
  const guest = data?.guest || {};
  const off = guest.pinboard === false;
  for (const name of ["camera", "board"]) {
    const button = document.querySelector(`[data-guest-tab="${name}"]`);
    if (button) button.hidden = off;
  }
  if (off && document.querySelector("[data-guest-tab].active")?.dataset.guestTab !== "scores") {
    showTab("scores");
  }
  if (guest.paused) {
    post.disabled = true;
    if (!status.textContent) status.textContent = "Photo uploads are paused.";
  }
}

async function watchTheme() {
  try {
    const res = await fetch("/api/guest");
    if (!res.ok) return;
    const data = await res.json();
    applyGuestAccess(data);
    applyTheme(data.state?.theme);
    boards = (data.state?.leaderboards || []).filter((board) => board.kind === "machine");
    if (!document.getElementById("panel-scores").hidden) {
      renderPicker();
      renderScores();
    }
  } catch {
    // keep the last theme
  }
}

loadFeed();
watchTheme();
setInterval(loadFeed, 8000);
setInterval(watchTheme, 8000);

const guestParams = new URLSearchParams(location.search);
if (guestParams.get("tab") === "scores" || guestParams.get("board")) showTab("scores");
