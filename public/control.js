const loginEl = document.getElementById("login");
const appEl = document.getElementById("app");
const loginForm = document.getElementById("login-form");
const pinInput = document.getElementById("pin-input");
const loginError = document.getElementById("login-error");
const slotsEl = document.getElementById("slots");
const boardSelect = document.getElementById("board-select");
const boardEditor = document.getElementById("board-editor");
const toastEl = document.getElementById("toast");

const SLOT_META = [
  { id: "1", label: "Left" },
  { id: "2", label: "Center" },
  { id: "3", label: "Right" },
];

const CONTENT = [
  { id: "pinnacle", label: "Pinnacle Group" },
  { id: "pinball-land", label: "Entertainment Center" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "off", label: "Black" },
];

let current = { state: { slots: {}, leaderboards: [] }, logos: {} };
let selectedBoardId = null;
let toastTimer = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 1800);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || res.statusText);
    error.status = res.status;
    throw error;
  }
  return data;
}

function applyPayload(payload) {
  current = payload;
  if (!selectedBoardId || !current.state.leaderboards.some((board) => board.id === selectedBoardId)) {
    selectedBoardId = current.state.leaderboards[0]?.id || null;
  }
  render();
}

function selectedBoard() {
  return current.state.leaderboards.find((board) => board.id === selectedBoardId) || null;
}

function renderSlots() {
  slotsEl.replaceChildren();
  for (const meta of SLOT_META) {
    const slot = current.state.slots[meta.id];
    const card = document.createElement("article");
    card.className = "slot-card";

    const title = document.createElement("h3");
    title.className = "slot-label";
    title.textContent = meta.label;
    card.append(title);

    const choices = document.createElement("div");
    choices.className = "choices";
    for (const option of CONTENT) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn${slot.content === option.id ? " active" : ""}`;
      button.textContent = option.label;
      button.addEventListener("click", async () => {
        const patch = { content: option.id };
        if (option.id === "leaderboard" && selectedBoardId) {
          patch.leaderboardId = selectedBoardId;
        }
        applyPayload(await api(`/api/slots/${meta.id}`, { method: "PUT", body: patch }));
      });
      choices.append(button);
    }
    card.append(choices);

    const pickerLabel = document.createElement("label");
    pickerLabel.textContent = "Event on this screen";
    const picker = document.createElement("select");
    for (const board of current.state.leaderboards) {
      const option = document.createElement("option");
      option.value = board.id;
      option.textContent = board.name;
      if (board.id === slot.leaderboardId) option.selected = true;
      picker.append(option);
    }
    if (!current.state.leaderboards.length) {
      const option = document.createElement("option");
      option.textContent = "No events yet";
      picker.append(option);
      picker.disabled = true;
    }
    picker.addEventListener("change", async () => {
      selectedBoardId = picker.value;
      applyPayload(
        await api(`/api/slots/${meta.id}`, {
          method: "PUT",
          body: { content: "leaderboard", leaderboardId: picker.value },
        })
      );
    });
    pickerLabel.append(picker);
    card.append(pickerLabel);
    slotsEl.append(card);
  }
}

function renderBoardSelect() {
  boardSelect.replaceChildren();
  for (const board of current.state.leaderboards) {
    const option = document.createElement("option");
    option.value = board.id;
    option.textContent = board.name;
    if (board.id === selectedBoardId) option.selected = true;
    boardSelect.append(option);
  }
  if (!current.state.leaderboards.length) {
    const option = document.createElement("option");
    option.textContent = "No events yet";
    boardSelect.append(option);
  }
}

function renderBoardEditor() {
  const board = selectedBoard();
  boardEditor.replaceChildren();
  if (!board) {
    boardEditor.textContent = "Create an event to start a leaderboard.";
    return;
  }

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Event name";
  const nameInput = document.createElement("input");
  nameInput.value = board.name;
  nameInput.addEventListener("change", async () => {
    applyPayload(await api(`/api/leaderboards/${board.id}`, { method: "PUT", body: { name: nameInput.value } }));
  });
  nameLabel.append(nameInput);
  boardEditor.append(nameLabel);

  const orderHint = document.createElement("p");
  orderHint.className = "muted";
  orderHint.textContent = "Rows stay in the order you set. Use Up/Down to change rank.";
  boardEditor.append(orderHint);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "btn";
  clearBtn.textContent = "Clear board";
  clearBtn.addEventListener("click", async () => {
    if (!confirm(`Clear every score on ${board.name}?`)) return;
    applyPayload(await api(`/api/leaderboards/${board.id}/clear`, { method: "POST" }));
    toast("Board cleared");
  });
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn danger";
  deleteBtn.textContent = "Delete event";
  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete ${board.name}?`)) return;
    applyPayload(await api(`/api/leaderboards/${board.id}`, { method: "DELETE" }));
  });
  actions.append(clearBtn, deleteBtn);
  boardEditor.append(actions);

  for (const row of board.rows) {
    const wrap = document.createElement("div");
    wrap.className = "player-row";
    const fields = document.createElement("div");
    fields.className = "player-fields";
    const name = document.createElement("input");
    name.value = row.name;
    name.placeholder = "Player";
    const score = document.createElement("input");
    score.value = row.score;
    score.inputMode = "numeric";
    score.placeholder = "Score";
    const save = async () => {
      applyPayload(
        await api(`/api/leaderboards/${board.id}/rows/${row.id}`, {
          method: "PUT",
          body: { name: name.value, score: score.value.replace(/,/g, "") },
        })
      );
    };
    name.addEventListener("change", save);
    score.addEventListener("change", save);
    fields.append(name, score);

    const icons = document.createElement("div");
    icons.className = "icon-row";
    const makeMove = (direction, label) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn compact";
      button.textContent = label;
      button.addEventListener("click", async () => {
        applyPayload(
          await api(`/api/leaderboards/${board.id}/rows/${row.id}/move`, {
            method: "POST",
            body: { direction },
          })
        );
      });
      return button;
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn compact danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      applyPayload(await api(`/api/leaderboards/${board.id}/rows/${row.id}`, { method: "DELETE" }));
    });
    icons.append(makeMove("up", "Up"), makeMove("down", "Down"), remove);
    wrap.append(fields, icons);
    boardEditor.append(wrap);
  }

  const add = document.createElement("form");
  add.className = "add-row";
  const addName = document.createElement("input");
  addName.placeholder = "New player";
  addName.required = true;
  const addScore = document.createElement("input");
  addScore.placeholder = "Score";
  addScore.inputMode = "numeric";
  const addBtn = document.createElement("button");
  addBtn.className = "btn primary";
  addBtn.textContent = "Add score";
  add.addEventListener("submit", async (event) => {
    event.preventDefault();
    applyPayload(
      await api(`/api/leaderboards/${board.id}/rows`, {
        method: "POST",
        body: { name: addName.value, score: addScore.value.replace(/,/g, "") },
      })
    );
    toast("Score added");
  });
  add.append(addName, addScore, addBtn);
  boardEditor.append(add);
}

function render() {
  renderSlots();
  renderBoardSelect();
  renderBoardEditor();
}

function showApp() {
  loginEl.hidden = true;
  appEl.hidden = false;
}

async function boot() {
  const auth = await api("/api/auth");
  if (!auth.ok) return;
  applyPayload(await api("/api/state"));
  showApp();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  try {
    await api("/api/login", { method: "POST", body: { pin: pinInput.value } });
    applyPayload(await api("/api/state"));
    showApp();
  } catch {
    loginError.hidden = false;
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  loginEl.hidden = false;
  appEl.hidden = true;
  pinInput.value = "";
});

document.getElementById("off-all").addEventListener("click", async () => {
  applyPayload(await api("/api/off", { method: "POST" }));
  toast("All screens black");
});

document.getElementById("new-board").addEventListener("click", async () => {
  const name = prompt("Event name", "New event");
  if (!name) return;
  const payload = await api("/api/leaderboards", { method: "POST", body: { name } });
  selectedBoardId = payload.state.leaderboards.at(-1)?.id || selectedBoardId;
  applyPayload(payload);
});

boardSelect.addEventListener("change", () => {
  selectedBoardId = boardSelect.value;
  render();
});

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state" && !appEl.hidden) {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        current = message;
        return;
      }
      applyPayload(message);
    }
  });
  socket.addEventListener("close", () => setTimeout(connect, 1000));
}

boot().catch(() => {});
connect();
