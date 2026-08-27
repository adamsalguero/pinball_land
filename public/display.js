const SLOT = location.pathname.split("/").pop();

const screen = document.getElementById("screen");
const offPanel = document.getElementById("off");
const logoPanel = document.getElementById("logo");
const logoImage = document.getElementById("logo-image");
const logoFallback = document.getElementById("logo-fallback");
const boardPanel = document.getElementById("board");
const boardTitle = document.getElementById("board-title");
const boardRows = document.getElementById("board-rows");
const boardEmpty = document.getElementById("board-empty");

function formatScore(score) {
  return Number(score || 0).toLocaleString("en-US");
}

function setMode(mode) {
  screen.dataset.mode = mode;
  offPanel.hidden = mode !== "off";
  logoPanel.hidden = mode !== "logo";
  boardPanel.hidden = mode !== "board";
}

function showOff() {
  setMode("off");
}

function showLogo(url, label) {
  setMode("logo");
  logoImage.alt = label;
  logoFallback.textContent = `${label} placeholder — replace the file in public/logos`;
  if (url) {
    logoFallback.hidden = true;
    logoImage.hidden = false;
    logoImage.src = url;
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

function showBoard(board) {
  setMode("board");
  boardTitle.textContent = board?.name || "Leaderboard";
  boardRows.replaceChildren();
  const rows = board?.rows || [];
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

function render({ state, logos }) {
  const slot = state.slots[SLOT];
  if (!slot || slot.content === "off") {
    showOff();
    return;
  }
  if (slot.content === "pinnacle") {
    showLogo(logos?.pinnacle, "Pinnacle Group Financial Services");
    return;
  }
  if (slot.content === "pinball-land") {
    showLogo(logos?.["pinball-land"], "Pinnacle Entertainment Center");
    return;
  }
  const board = (state.leaderboards || []).find((item) => item.id === slot.leaderboardId);
  showBoard(board);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      render(message);
    }
  });
  socket.addEventListener("close", () => {
    setTimeout(connect, 1000);
  });
}

fetch("/api/state")
  .then((res) => res.json())
  .then(render)
  .catch(() => showOff());

connect();
