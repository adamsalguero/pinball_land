const preview = document.getElementById("preview");
const still = document.getElementById("still");
const hint = document.getElementById("stage-hint");
const shutter = document.getElementById("shutter");
const fileInput = document.getElementById("file");
const post = document.getElementById("post");
const status = document.getElementById("post-status");
const feed = document.getElementById("feed");
const feedEmpty = document.getElementById("feed-empty");
const scores = document.getElementById("scores");

let stream = null;
let facing = "environment";
let blob = null;
let queue = [];

function standalone() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function tap() {
  if (navigator.vibrate) navigator.vibrate(10);
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

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    fileInput.click();
    return;
  }
  if (stream) stream.getTracks().forEach((track) => track.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    preview.srcObject = stream;
    preview.hidden = false;
    still.hidden = true;
    hint.hidden = true;
  } catch {
    hint.hidden = false;
    hint.textContent = "Camera is unavailable. Pick a photo from your library.";
  }
}

function useBlob(next) {
  blob = next;
  queue = next ? [next] : [];
  still.src = next ? URL.createObjectURL(next) : "";
  still.hidden = !next;
  preview.hidden = Boolean(next);
  hint.hidden = Boolean(next);
  post.disabled = !next;
}

shutter.addEventListener("click", async () => {
  tap();
  if (!stream) {
    await openCamera();
    return;
  }
  const track = stream.getVideoTracks()[0];
  const image = track && "ImageCapture" in window ? new ImageCapture(track) : null;
  try {
    if (image) {
      useBlob(await image.takePhoto());
      return;
    }
  } catch {
    // fall through to the canvas grab
  }
  const canvas = document.createElement("canvas");
  canvas.width = preview.videoWidth || 1280;
  canvas.height = preview.videoHeight || 720;
  canvas.getContext("2d").drawImage(preview, 0, 0);
  canvas.toBlob((file) => useBlob(file), "image/jpeg", 0.92);
});

document.getElementById("library").addEventListener("click", () => fileInput.click());
document.getElementById("flip").addEventListener("click", async () => {
  facing = facing === "environment" ? "user" : "environment";
  await openCamera();
});

fileInput.addEventListener("change", () => {
  const files = [...fileInput.files];
  if (!files.length) return;
  queue = files;
  useBlob(files[0]);
  blob = files[0];
  post.disabled = false;
  if (files.length > 1) status.textContent = `${files.length} photos ready.`;
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
    const files = queue.length ? queue : blob ? [blob] : [];
    const sent = [];
    for (const file of files) sent.push(await uploadOne(file));
    const waiting = sent.some((photo) => photo.status === "pending");
    status.textContent = waiting
      ? "Posted. It shows on the wall after the host approves it."
      : "Posted. It is on the pinboard.";
    useBlob(null);
    queue = [];
    fileInput.value = "";
    loadFeed();
  } catch (err) {
    status.textContent = err.message;
    post.disabled = false;
  }
});

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
    copy.textContent = [photo.guestName, photo.caption].filter(Boolean).join(" — ") || "On the wall";
    card.append(img, copy);
    feed.append(card);
  }
}

async function loadScores() {
  const res = await fetch("/api/state");
  const data = await res.json();
  scores.replaceChildren();
  for (const board of data.state?.leaderboards || []) {
    if (board.kind === "machine") continue;
    const wrap = document.createElement("section");
    const title = document.createElement("h2");
    title.textContent = board.name;
    wrap.append(title);
    for (const row of board.rows || []) {
      const line = document.createElement("div");
      line.className = "score-card";
      line.innerHTML = `<span>${row.name || "—"}</span><strong>${Number(row.score || 0).toLocaleString("en-US")}</strong>`;
      wrap.append(line);
    }
    scores.append(wrap);
  }
}

for (const button of document.querySelectorAll("[data-guest-tab]")) {
  button.addEventListener("click", () => showTab(button.dataset.guestTab));
}

const install = document.getElementById("install-hint");
if (!standalone() && !localStorage.getItem("pl-guest-hint")) install.hidden = false;
document.getElementById("dismiss-hint").addEventListener("click", () => {
  install.hidden = true;
  localStorage.setItem("pl-guest-hint", "1");
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

loadFeed();
setInterval(loadFeed, 8000);
openCamera().catch(() => {});
