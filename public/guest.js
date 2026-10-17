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
  blob = next;
  still.src = next ? URL.createObjectURL(next) : "";
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

async function shareOrDownload(url, filename) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (ios && typeof navigator.share === "function") {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
      const payload = { files: [file], title: "Pinball Land" };
      if (typeof navigator.canShare !== "function" || navigator.canShare(payload)) {
        await navigator.share(payload);
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  const link = document.createElement("a");
  link.href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function when(stamp) {
  const n = Number(stamp);
  if (!n) return "";
  return new Date(n).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadFeed() {
  const res = await fetch("/api/guest-photos/feed");
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
    const download = document.createElement("button");
    download.type = "button";
    download.className = "btn download";
    download.textContent = "Save photo";
    download.addEventListener("click", () => {
      shareOrDownload(photo.url, `${photo.id}.jpg`).catch(() => {});
    });
    card.append(img, copy, download);
    feed.append(card);
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

async function loadScores() {
  const res = await fetch("/api/state");
  const data = await res.json();
  applyTheme(data.state?.theme);
  boards = (data.state?.leaderboards || []).filter((board) => board.kind === "machine");
  renderPicker();
  renderScores();
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
    note.textContent = "Sent. It shows on the board after the host approves it.";
    event.target.reset();
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

async function watchTheme() {
  try {
    const res = await fetch("/api/state");
    const data = await res.json();
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
