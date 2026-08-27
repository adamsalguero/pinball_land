const loginEl = document.getElementById("login");
const appEl = document.getElementById("app");
const loginForm = document.getElementById("login-form");
const pinInput = document.getElementById("pin-input");
const loginError = document.getElementById("login-error");
const slotsEl = document.getElementById("slots");
const boardSelect = document.getElementById("board-select");
const boardEditor = document.getElementById("board-editor");
const toastEl = document.getElementById("toast");
const rotationItemsEl = document.getElementById("rotation-items");
const intervalInput = document.getElementById("interval");
const machineSearch = document.getElementById("machine-search");
const machineResults = document.getElementById("machine-results");
const opdbHelp = document.getElementById("opdb-help");
const manualScreens = document.getElementById("manual-screens");
const offAll = document.getElementById("off-all");

const SLOT_META = [
  { id: "1", label: "Left" },
  { id: "2", label: "Center" },
  { id: "3", label: "Right" },
];

const CONTENT_GROUPS = [
  {
    label: "Brand",
    options: [
      { id: "pinnacle", label: "Pinnacle Group" },
      { id: "pinball-land", label: "Entertainment Center" },
    ],
  },
  {
    label: "Amenities",
    options: [
      { id: "amenity-arcade", label: "2-story arcade" },
      { id: "amenity-oasis", label: "Outdoor Oasis" },
      { id: "amenity-events", label: "Event options" },
    ],
  },
  {
    label: "Show",
    options: [
      { id: "leaderboard", label: "Leaderboard" },
      { id: "off", label: "Black" },
    ],
  },
];

const ROTATION_TOGGLES = [
  { id: "logoPinnacle", label: "Pinnacle Group logo" },
  { id: "logoEntertainment", label: "Entertainment Center logo" },
  { id: "amenityArcade", label: "2-story arcade" },
  { id: "amenityOasis", label: "Outdoor Oasis" },
  { id: "amenityEvents", label: "Flexible Event Options" },
];

let current = {
  state: { slots: {}, leaderboards: [], rotation: { items: {} } },
  logos: {},
  playlist: [],
  opdb: { configured: false },
};
let selectedBoardId = null;
let toastTimer = null;
let searchTimer = null;

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

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "halloween" ? "halloween" : "pinnacle";
  const pinnacleBtn = document.getElementById("theme-pinnacle");
  const halloweenBtn = document.getElementById("theme-halloween");
  if (!pinnacleBtn || !halloweenBtn) return;
  pinnacleBtn.classList.toggle("active", theme !== "halloween");
  halloweenBtn.classList.toggle("active", theme === "halloween");
}

function selectedBoard() {
  return current.state.leaderboards.find((board) => board.id === selectedBoardId) || null;
}

function isSlotActive(content, optionId) {
  if (optionId === "amenity-arcade") {
    return ["amenity-arcade", "photos", "arcade", "collage", "venue"].includes(content);
  }
  if (optionId === "amenity-oasis") {
    return ["amenity-oasis", "pool", "bar"].includes(content);
  }
  return content === optionId;
}

function renderOffButton() {
  const blackout = Boolean(current.state.blackout);
  offAll.textContent = blackout ? "Resume wall" : "Off — black all screens";
  offAll.classList.toggle("danger", !blackout);
  offAll.classList.toggle("primary", blackout);
}

function renderRotation() {
  const rotation = current.state.rotation || { enabled: true, intervalSec: 14, items: {} };
  document.getElementById("rotation-on").classList.toggle("active", rotation.enabled !== false);
  document.getElementById("rotation-off").classList.toggle("active", rotation.enabled === false);
  if (document.activeElement !== intervalInput) {
    intervalInput.value = String(rotation.intervalSec || 14);
  }
  rotationItemsEl.replaceChildren();
  for (const item of ROTATION_TOGGLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn toggle${rotation.items?.[item.id] !== false ? " active" : ""}`;
    button.textContent = item.label;
    button.addEventListener("click", async () => {
      applyPayload(
        await api("/api/rotation", {
          method: "PUT",
          body: { items: { [item.id]: rotation.items?.[item.id] === false } },
        })
      );
    });
    rotationItemsEl.append(button);
  }
  manualScreens.hidden = rotation.enabled !== false;
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

    for (const group of CONTENT_GROUPS) {
      const heading = document.createElement("p");
      heading.className = "choice-heading";
      heading.textContent = group.label;
      card.append(heading);
      const choices = document.createElement("div");
      choices.className = "choices";
      for (const option of group.options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn${isSlotActive(slot.content, option.id) ? " active" : ""}`;
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
    }

    const pickerLabel = document.createElement("label");
    pickerLabel.textContent = "Board on this screen";
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
      option.textContent = "No boards yet";
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

function renderOpdbHelp() {
  if (current.opdb?.configured) {
    opdbHelp.textContent = "Search adds the machine, enables its leaderboard, and caches backglass art for the wall.";
  } else {
    opdbHelp.textContent =
      "Free OPDB token: create an account at opdb.org, generate an API token, then put it in config.json as opdbApiKey (or env OPDB_API_KEY). Search still works; art downloads need the token. You can also add a machine by name below so tonight is not blocked.";
  }
}

function renderBoardSelect() {
  boardSelect.replaceChildren();
  for (const board of current.state.leaderboards) {
    const option = document.createElement("option");
    option.value = board.id;
    const kind = board.kind === "machine" ? "machine" : "event";
    option.textContent = `${board.name} (${kind}${board.inRotation ? "" : ", hidden"})`;
    if (board.id === selectedBoardId) option.selected = true;
    boardSelect.append(option);
  }
  if (!current.state.leaderboards.length) {
    const option = document.createElement("option");
    option.textContent = "No boards yet";
    boardSelect.append(option);
  }
}

function renderBoardEditor() {
  const board = selectedBoard();
  boardEditor.replaceChildren();
  if (!board) {
    boardEditor.textContent = "Create an event or add a machine to start a leaderboard.";
    return;
  }

  const nameLabel = document.createElement("label");
  nameLabel.textContent = board.kind === "machine" ? "Machine name" : "Event name";
  const nameInput = document.createElement("input");
  nameInput.value = board.name;
  nameInput.addEventListener("change", async () => {
    applyPayload(await api(`/api/leaderboards/${board.id}`, { method: "PUT", body: { name: nameInput.value } }));
  });
  nameLabel.append(nameInput);
  boardEditor.append(nameLabel);

  const wallBtn = document.createElement("button");
  wallBtn.type = "button";
  wallBtn.className = `btn toggle${board.inRotation ? " active" : ""}`;
  wallBtn.textContent = board.inRotation ? "On the wall" : "Not on the wall";
  wallBtn.addEventListener("click", async () => {
    applyPayload(
      await api(`/api/leaderboards/${board.id}`, {
        method: "PUT",
        body: { inRotation: !board.inRotation },
      })
    );
  });
  boardEditor.append(wallBtn);

  if (board.kind === "machine") {
    const meta = document.createElement("p");
    meta.className = "muted";
    const bits = [board.manufacturer, board.year, board.opdbId].filter(Boolean);
    meta.textContent = bits.length
      ? bits.join(" · ") + (board.artUrl ? " · art cached" : " · no cached art yet")
      : "Added by name. Art appears after an OPDB token is set and the machine is re-added from search.";
    boardEditor.append(meta);
  }

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
  deleteBtn.textContent = board.kind === "machine" ? "Remove machine" : "Delete event";
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
  applyTheme(current.state?.theme);
  renderOffButton();
  renderRotation();
  renderOpdbHelp();
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

offAll.addEventListener("click", async () => {
  if (current.state.blackout) {
    applyPayload(await api("/api/resume", { method: "POST" }));
    toast("Wall resumed");
  } else {
    applyPayload(await api("/api/off", { method: "POST" }));
    toast("All screens black");
  }
});

document.getElementById("theme-pinnacle").addEventListener("click", async () => {
  applyPayload(await api("/api/theme", { method: "PUT", body: { theme: "pinnacle" } }));
});

document.getElementById("theme-halloween").addEventListener("click", async () => {
  applyPayload(await api("/api/theme", { method: "PUT", body: { theme: "halloween" } }));
  toast("Halloween theme on");
});

document.getElementById("rotation-on").addEventListener("click", async () => {
  applyPayload(await api("/api/rotation", { method: "PUT", body: { enabled: true } }));
});

document.getElementById("rotation-off").addEventListener("click", async () => {
  applyPayload(await api("/api/rotation", { method: "PUT", body: { enabled: false } }));
});

intervalInput.addEventListener("change", async () => {
  applyPayload(
    await api("/api/rotation", {
      method: "PUT",
      body: { intervalSec: intervalInput.value },
    })
  );
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

document.getElementById("manual-machine").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("manual-machine-name").value.trim();
  if (!name) return;
  const payload = await api("/api/machines", { method: "POST", body: { name } });
  selectedBoardId = payload.state.leaderboards.at(-1)?.id || selectedBoardId;
  document.getElementById("manual-machine-name").value = "";
  applyPayload(payload);
  toast(`${name} added`);
});

machineSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = machineSearch.value.trim();
  if (q.length < 2) {
    machineResults.replaceChildren();
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/opdb/search?q=${encodeURIComponent(q)}`);
      machineResults.replaceChildren();
      if (!data.results?.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No matches. Add it by name below.";
        machineResults.append(empty);
        return;
      }
      for (const item of data.results.slice(0, 8)) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "btn search-hit";
        row.textContent = item.detail ? `${item.name} — ${item.detail}` : item.name;
        row.addEventListener("click", async () => {
          const payload = await api("/api/machines", {
            method: "POST",
            body: { name: item.name, opdbId: item.opdbId },
          });
          selectedBoardId = payload.state.leaderboards.at(-1)?.id || selectedBoardId;
          machineSearch.value = "";
          machineResults.replaceChildren();
          applyPayload(payload);
          toast(`${item.name} added`);
        });
        machineResults.append(row);
      }
    } catch (err) {
      machineResults.textContent = err.message || "Search failed";
    }
  }, 280);
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
