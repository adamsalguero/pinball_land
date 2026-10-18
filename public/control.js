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
const SLOT_META = [
  { id: "1", label: "Left" },
  { id: "2", label: "Center" },
  { id: "3", label: "Right" },
];

const CONTENT_GROUPS = [
  {
    label: "On this screen",
    options: [
      { id: "logos", label: "Logos" },
      { id: "amenities", label: "Amenities" },
      { id: "leaderboard", label: "Leaderboards" },
      { id: "pinboard", label: "Live Pinboard/Photos" },
      { id: "video", label: "Video" },
      { id: "clock", label: "Clock" },
    ],
  },
];

const ROTATION_TOGGLES = [
  { id: "logoPinnacle", label: "Pinnacle Group logo" },
  { id: "logoEntertainment", label: "Entertainment Center logo" },
  { id: "amenities", label: "Amenities" },
  { id: "clock", label: "Clock and next event" },
  { id: "pinboard", label: "Live pinboard" },
];

let current = {
  state: { slots: {}, leaderboards: [], rotation: { items: {} } },
  logos: {},
  playlist: [],
  opdb: { configured: false },
};
let selectedBoardId = null;
let presentSlot = "1";
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

function deviceToken() {
  return localStorage.getItem("pl-admin-device") || "";
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|; )pl_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function api(url, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (deviceToken()) headers["x-device-token"] = deviceToken();
  const csrf = csrfToken();
  if (csrf) headers["x-csrf"] = csrf;
  const res = await fetch(url, {
    headers,
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
  const name = theme === "halloween" || theme === "christmas" ? theme : "pinnacle";
  document.documentElement.dataset.theme = name;
  for (const id of ["pinnacle", "halloween", "christmas"]) {
    const button = document.getElementById(`theme-${id}`);
    if (button) button.classList.toggle("active", name === id);
  }
}

function selectedBoard() {
  return current.state.leaderboards.find((board) => board.id === selectedBoardId) || null;
}

function isSlotActive(content, optionId) {
  return content === optionId;
}

function renderRotation() {
  const rotationOn = document.getElementById("rotation-on");
  if (!rotationOn || !intervalInput || !rotationItemsEl) return;
  const rotation = current.state.rotation || { enabled: true, intervalSec: 30, items: {} };
  rotationOn.classList.toggle("active", rotation.enabled !== false);
  document.getElementById("rotation-off").classList.toggle("active", rotation.enabled === false);
  if (document.activeElement !== intervalInput) {
    intervalInput.value = String(rotation.intervalSec || 30);
  }
  rotationItemsEl.replaceChildren();
  const pinboardOn = current.guest?.pinboard !== false;
  for (const item of ROTATION_TOGGLES) {
    if (item.id === "pinboard" && !pinboardOn) continue;
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
  if (!slotsEl) return;
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
        if (option.id === "pinboard" && current.guest?.pinboard === false) continue;
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
  nameLabel.textContent = "Machine name";
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
  orderHint.textContent = "Scores sort highest first when you enter a name and score.";
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
  const archiveBtn = document.createElement("button");
  archiveBtn.type = "button";
  archiveBtn.className = "btn";
  archiveBtn.textContent = "Archive";
  archiveBtn.addEventListener("click", async () => {
    applyPayload(await api(`/api/leaderboards/${board.id}/archive`, { method: "POST" }));
    toast("Board archived");
  });
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete ${board.name}? This cannot be undone.`)) return;
    applyPayload(await api(`/api/leaderboards/${board.id}`, { method: "DELETE" }));
  });
  actions.append(clearBtn, archiveBtn, deleteBtn);
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
    if (row.proofFile) {
      const proof = document.createElement("img");
      proof.src = `/media/score-proofs/${row.proofFile}`;
      proof.alt = "Score photo";
      proof.style.width = "72px";
      wrap.append(proof);
      const show = document.createElement("button");
      show.type = "button";
      show.className = `btn compact toggle${row.showOnWall !== false ? " active" : ""}`;
      show.textContent = "Show photo on wall";
      show.setAttribute("aria-pressed", row.showOnWall !== false ? "true" : "false");
      show.addEventListener("click", async () => {
        applyPayload(await api(`/api/leaderboards/${board.id}/rows/${row.id}`, {
          method: "PUT",
          body: { showOnWall: row.showOnWall === false },
        }));
      });
      const dropPhoto = document.createElement("button");
      dropPhoto.type = "button";
      dropPhoto.className = "btn compact";
      dropPhoto.textContent = "Remove photo";
      dropPhoto.addEventListener("click", async () => {
        applyPayload(await api(`/api/leaderboards/${board.id}/rows/${row.id}`, {
          method: "PUT",
          body: { removeProof: true },
        }));
        toast("Photo removed");
      });
      icons.append(show, dropPhoto);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn compact danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      applyPayload(await api(`/api/leaderboards/${board.id}/rows/${row.id}`, { method: "DELETE" }));
    });
    icons.append(remove);
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

function displayLabel(slot, count) {
  const n = Number(slot);
  const total = Number(count) || 3;
  if (total <= 1) return "Screen";
  if (total === 2) return n === 1 ? "Left" : "Right";
  return { 1: "Left", 2: "Center", 3: "Right" }[n] || `Screen ${n}`;
}

const DISPLAY_CONTENT = [
  { id: "rotation", label: "Auto" },
  { id: "logos", label: "Logos" },
  { id: "amenities", label: "Amenities" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "pinboard", label: "Pinboard" },
  { id: "video", label: "Video" },
  { id: "clock", label: "Clock" },
];

function shareUrl() {
  const share = current.share || {};
  const host = share.hosts?.[0] || location.hostname;
  const protocol = share.secure ? "https" : "http";
  const port = share.port || location.port;
  return `${protocol}://${host}:${port}${share.path || "/present"}`;
}

async function saveDisplays(patch) {
  applyPayload(await api("/api/displays", { method: "PUT", body: patch }));
}

function renderDisplays() {
  const root = document.getElementById("displays-root");
  if (!root) return;
  const displays = current.displays || { count: 3, mirror: false, order: [], screens: {} };
  const count = 3;
  root.replaceChildren();

  for (const slot of ["1", "2", "3"]) {
    const screenCfg = displays.screens?.[slot] || { enabled: true, content: "rotation" };
    const layout = current.layout?.[slot] || screenCfg;
    const card = document.createElement("article");
    card.className = "slot-card screen-card";
    const title = document.createElement("h3");
    title.className = "slot-label";
    title.textContent = displayLabel(slot, count);
    card.append(title);

    if (displays.mirror && slot !== "1") {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Shows the same layout as screen 1.";
      card.append(note);
    } else {
      const choices = document.createElement("div");
      choices.className = "choices";
      for (const option of DISPLAY_CONTENT) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn${layout.content === option.id ? " active" : ""}`;
        button.textContent = option.label;
        button.addEventListener("click", () => {
          const patch = { content: option.id };
          if (option.id === "leaderboard") {
            patch.leaderboardId = screenCfg.leaderboardId || selectedBoardId || current.state.leaderboards[0]?.id || null;
          }
          saveDisplays({ screens: { [slot]: patch } }).then(() => toast("Layout saved"));
        });
        choices.append(button);
      }
      card.append(choices);

      if (layout.content === "leaderboard") {
        const pickerLabel = document.createElement("label");
        pickerLabel.textContent = "Board on this screen";
        const picker = document.createElement("select");
        for (const board of current.state.leaderboards) {
          const option = document.createElement("option");
          option.value = board.id;
          option.textContent = board.name;
          if (board.id === (screenCfg.leaderboardId || layout.leaderboardId)) option.selected = true;
          picker.append(option);
        }
        picker.addEventListener("change", () => {
          saveDisplays({
            screens: { [slot]: { content: "leaderboard", leaderboardId: picker.value } },
          });
        });
        pickerLabel.append(picker);
        card.append(pickerLabel);
      }
    }
    root.append(card);
  }

  const monitorWrap = document.createElement("div");
  monitorWrap.id = "monitor-order";
  renderMonitorOrder(monitorWrap);
  root.append(monitorWrap);

  const restart = document.createElement("button");
  restart.type = "button";
  restart.className = "btn";
  restart.textContent = "Restart kiosk windows";
  restart.addEventListener("click", async () => {
    applyPayload(await api("/api/kiosk/restart", { method: "POST" }));
    toast("Kiosk windows will reopen in a few seconds");
  });
  root.append(restart);
}

function renderMonitorOrder(monitorWrap) {
  const displays = current.displays || { order: [] };
  const monitors = current.kiosk?.monitors || [];
  monitorWrap.replaceChildren();
  const monitorTitle = document.createElement("p");
  monitorTitle.className = "choice-heading";
  monitorTitle.textContent = "Monitor order";
  monitorWrap.append(monitorTitle);
  if (!monitors.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No kiosk monitors reported yet. On the wall PC, npm run kiosk reports them. Until then, windows follow Windows left to right.";
    monitorWrap.append(empty);
    return;
  }
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = displays.order?.length
    ? "Manual order is on. Reset to follow left to right."
    : "Left to right from Windows. Move a monitor if that mapping is wrong.";
  monitorWrap.append(hint);
  monitors.forEach((monitor, index) => {
    const row = document.createElement("div");
    row.className = "row-actions";
    const label = document.createElement("p");
    label.className = "muted";
    const bounds = monitor.bounds || {};
    label.textContent = `Monitor ${index + 1}: ${bounds.width || "?"}×${bounds.height || "?"} at (${bounds.x || 0}, ${bounds.y || 0})`;
    const buttons = document.createElement("div");
    buttons.className = "icon-row";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "btn compact";
    up.textContent = "Up";
    up.disabled = index === 0;
    up.addEventListener("click", () => moveMonitor(index, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "btn compact";
    down.textContent = "Down";
    down.disabled = index === monitors.length - 1;
    down.addEventListener("click", () => moveMonitor(index, 1));
    buttons.append(up, down);
    row.append(label, buttons);
    monitorWrap.append(row);
  });
  if (displays.order?.length) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "btn ghost";
    reset.textContent = "Reset to left-to-right";
    reset.addEventListener("click", () => saveDisplays({ order: [] }).then(() => toast("Using left-to-right order")));
    monitorWrap.append(reset);
  }
  const skipped = current.kiosk?.skipped || [];
  if (skipped.length && monitors.length) {
    const warn = document.createElement("p");
    warn.className = "muted";
    warn.textContent = `No physical monitor for display ${skipped.join(", ")}. Those windows are skipped.`;
    monitorWrap.append(warn);
  }
}

function moveMonitor(index, delta) {
  const monitors = current.kiosk?.monitors || [];
  const order = monitors.map((monitor) => String(monitor.id));
  const next = index + delta;
  if (next < 0 || next >= order.length) return;
  const [item] = order.splice(index, 1);
  order.splice(next, 0, item);
  saveDisplays({ order }).then(() => toast("Monitor order saved"));
}

function renderPresent() {
  const root = document.getElementById("present-root");
  if (!root) return;
  const displays = current.displays || { count: 3, screens: {} };
  const enabled = ["1", "2", "3"].filter((slot) => current.layout?.[slot]?.enabled);
  if (!enabled.includes(presentSlot)) presentSlot = enabled[0] || "1";
  root.replaceChildren();

  const pick = document.createElement("div");
  pick.className = "choice-row";
  for (const slot of ["1", "2", "3"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn${presentSlot === slot ? " active" : ""}`;
    button.textContent = displayLabel(slot, displays.count);
    button.disabled = !current.layout?.[slot]?.enabled;
    button.addEventListener("click", () => {
      presentSlot = slot;
      renderPresent();
    });
    pick.append(button);
  }
  root.append(pick);

  const session = current.presentations?.[presentSlot];
  const status = document.createElement("p");
  status.className = "muted";
  if (!current.layout?.[presentSlot]?.enabled) {
    status.textContent = "Turn this display on under Displays before presenting on it.";
  } else if (!session) {
    status.textContent = `${displayLabel(presentSlot, displays.count)} stays in rotation until you start something.`;
  } else {
    const names = { webrtc: "browser share", airplay: "AirPlay", url: "a web page", file: "an uploaded file" };
    status.textContent = `${displayLabel(presentSlot, displays.count)} is showing ${names[session.source] || "a presentation"}. Other screens keep rotating.`;
  }
  root.append(status);

  if (session?.source === "webrtc" && session.code) {
    const code = document.createElement("p");
    code.className = "present-code-inline";
    code.textContent = session.code;
    root.append(code);
    const guest = document.createElement("p");
    guest.className = "muted";
    guest.textContent = `Guest opens ${shareUrl()} and enters that code. The same code is on the screen. iPhones use AirPlay instead.`;
    root.append(guest);
  }
  if (session?.source === "airplay") {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = session.helper?.ok === false
      ? session.helper.error
      : `On the iPhone: Control Center → Screen Mirroring → ${current.airplay?.serverName || "Pinball Land"}.`;
    root.append(note);
  }

  if (session) {
    const endRow = document.createElement("div");
    endRow.className = "theme-toggle";
    const end = document.createElement("button");
    end.type = "button";
    end.className = "btn danger";
    end.textContent = "End presentation";
    end.addEventListener("click", async () => {
      applyPayload(await api(`/api/present/${presentSlot}/end`, { method: "POST" }));
      toast("Back to rotation");
    });
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn";
    keep.textContent = "Keep showing";
    keep.addEventListener("click", async () => {
      applyPayload(await api(`/api/present/${presentSlot}/touch`, { method: "POST" }));
      toast("Idle timer reset");
    });
    endRow.append(end, keep);
    root.append(endRow);
  } else if (current.layout?.[presentSlot]?.enabled) {
    const sources = document.createElement("div");
    sources.className = "choices";
    const share = document.createElement("button");
    share.type = "button";
    share.className = "btn primary";
    share.textContent = "Browser share";
    share.addEventListener("click", () => startPresent({ source: "webrtc" }));
    sources.append(share);
    root.append(sources);

    const urlForm = document.createElement("form");
    urlForm.className = "add-row";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "https://example.com";
    urlInput.required = true;
    const urlBtn = document.createElement("button");
    urlBtn.className = "btn";
    urlBtn.type = "submit";
    urlBtn.textContent = "Show this URL";
    urlForm.append(urlInput, urlBtn);
    urlForm.addEventListener("submit", (event) => {
      event.preventDefault();
      startPresent({ source: "url", url: urlInput.value });
    });
    root.append(urlForm);

    const fileForm = document.createElement("form");
    fileForm.className = "add-row";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,application/pdf";
    fileInput.required = true;
    const fileBtn = document.createElement("button");
    fileBtn.className = "btn";
    fileBtn.type = "submit";
    fileBtn.textContent = "Show PDF or image";
    fileForm.append(fileInput, fileBtn);
    fileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const file = fileInput.files?.[0];
      if (!file) return;
      const res = await fetch(`/api/present/${presentSlot}/file`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": file.type || "application/octet-stream", "x-filename": file.name },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error || "Upload failed");
        return;
      }
      applyPayload(data);
      toast("Showing the file");
    });
    root.append(fileForm);
  }

  const idleLabel = document.createElement("label");
  idleLabel.className = "interval-label";
  idleLabel.textContent = "End a presentation after this many idle minutes";
  const idle = document.createElement("input");
  idle.type = "number";
  idle.min = "1";
  idle.max = "180";
  idle.value = String(current.presentation?.idleMinutes || 10);
  idle.addEventListener("change", async () => {
    applyPayload(await api("/api/presentation", { method: "PUT", body: { idleMinutes: idle.value } }));
    toast("Idle time saved");
  });
  idleLabel.append(idle);
  root.append(idleLabel);

}

async function startPresent(body) {
  try {
    const data = await api(`/api/present/${presentSlot}/start`, { method: "POST", body });
    applyPayload(data);
    const session = data.presentations?.[presentSlot];
    if (session?.helper && session.helper.ok === false) toast(session.helper.error);
    else if (session?.source === "webrtc") toast(`Code ${session.code} is on the screen`);
    else toast("Presentation started");
  } catch (err) {
    toast(err.message || "Could not start");
  }
}

function renderAirplay() {
  const root = document.getElementById("airplay-root");
  if (!root) return;
  root.replaceChildren();
  const air = current.airplay || {};
  const status = document.createElement("p");
  status.className = "muted";
  if (air.ready === false) {
    status.textContent = "UxPlay is not installed yet. On the wall PC run scripts\\install-airplay-windows.ps1. Browser share still works.";
  } else if (air.active && air.target && air.target !== "off") {
    status.textContent = air.target === "all"
      ? "Mirroring to every screen. It returns to rotation when the iPhone disconnects."
      : `Mirroring to ${displayLabel(air.target, current.displays?.count)}. It returns to rotation when the iPhone disconnects.`;
  } else if (air.target && air.target !== "off") {
    status.textContent = air.target === "all"
      ? `Receiver ${air.serverName || "Pinball Land"} is ready for all screens. On the iPhone: Control Center → Screen Mirroring.`
      : `Receiver ${air.serverName || "Pinball Land"} is ready for ${displayLabel(air.target, current.displays?.count)}. On the iPhone: Control Center → Screen Mirroring.`;
  } else {
    status.textContent = `Receiver ${air.running ? "is on" : "starts with the server"}. Tap a screen, then mirror to ${air.serverName || "Pinball Land"}.`;
  }
  root.append(status);

  const row = document.createElement("div");
  row.className = "choice-row";
  const choices = [
    ["1", displayLabel("1", current.displays?.count)],
    ["2", displayLabel("2", current.displays?.count)],
    ["3", displayLabel("3", current.displays?.count)],
    ["all", "All three"],
    ["off", "Off"],
  ];
  for (const [target, label] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn${air.target === target ? " active" : ""}${target === "off" ? "" : " primary"}`;
    if (target === "off") button.classList.remove("primary");
    button.textContent = label;
    button.disabled = ["1", "2", "3"].includes(target) && !current.layout?.[target]?.enabled;
    button.addEventListener("click", async () => {
      applyPayload(await api("/api/airplay/target", { method: "PUT", body: { target } }));
      toast(target === "off" ? "AirPlay target cleared" : "AirPlay target saved");
    });
    row.append(button);
  }
  root.append(row);
}

let plugAction = null;
let plugActionTimer = null;

function notePlugAction(text, ok) {
  plugAction = { text, ok, at: Date.now() };
  clearTimeout(plugActionTimer);
  plugActionTimer = setTimeout(() => {
    plugAction = null;
    renderPlugs();
  }, 2500);
}

function renderPlugs() {
  const root = document.getElementById("plugs-root");
  if (!root) return;
  const focused = document.activeElement;
  if (focused && root.contains(focused) && ["plug-email", "plug-password", "plug-ip"].includes(focused.id)) return;
  root.replaceChildren();
  const plugs = current.plugs || { assignments: {}, devices: [], schedule: {} };
  const tools = document.createElement("div");
  tools.className = "theme-toggle";
  const discover = document.createElement("button");
  discover.type = "button";
  discover.className = "btn";
  discover.textContent = "Find plugs";
  discover.addEventListener("click", async () => {
    try {
      applyPayload(await api("/api/plugs/discover", { method: "POST" }));
      const count = current.plugs?.devices?.length || 0;
      toast(count ? `Found ${count}` : "No plugs answered. Add the plug by its IP address if it is on this network.");
    } catch (err) {
      toast(err.message || "The plug did not answer.");
    }
  });
  const allOn = document.createElement("button");
  allOn.type = "button";
  allOn.className = "btn primary";
  allOn.textContent = "TVs On";
  allOn.addEventListener("click", async () => {
    try {
      const payload = await api("/api/plugs/power", { method: "POST", body: { on: true } });
      notePlugAction("TVs on", true);
      applyPayload(payload);
      toast("Plugs on");
    } catch (err) {
      notePlugAction(err.message || "The plug did not answer.", false);
      renderPlugs();
      toast(err.message || "The plug did not answer.");
    }
  });
  const allOff = document.createElement("button");
  allOff.type = "button";
  allOff.className = "btn danger";
  allOff.textContent = "TVs Off";
  allOff.addEventListener("click", async () => {
    try {
      const payload = await api("/api/plugs/power", { method: "POST", body: { on: false } });
      notePlugAction("TVs off", true);
      applyPayload(payload);
      toast("Plugs off");
    } catch (err) {
      notePlugAction(err.message || "The plug did not answer.", false);
      renderPlugs();
      toast(err.message || "The plug did not answer.");
    }
  });
  tools.append(discover, allOn, allOff);
  root.append(tools);
  if (plugs.notice) {
    const notice = document.createElement("p");
    notice.className = "muted";
    notice.id = "plug-notice";
    notice.textContent = plugs.notice;
    root.append(notice);
  }
  const account = plugs.account || {};
  const login = document.createElement("form");
  login.className = "stack";
  login.id = "plug-account-form";
  const email = document.createElement("input");
  email.id = "plug-email";
  email.type = "email";
  email.autocomplete = "username";
  email.placeholder = account.configured ? `Saved (${account.username || "TP-Link email"})` : "Kasa app email";
  email.ariaLabel = "TP-Link email";
  const password = document.createElement("input");
  password.id = "plug-password";
  password.type = "password";
  password.autocomplete = "current-password";
  password.placeholder = account.configured ? "Password saved" : "Kasa app password";
  password.ariaLabel = "TP-Link password";
  const saveLogin = document.createElement("button");
  saveLogin.className = "btn";
  saveLogin.type = "submit";
  saveLogin.textContent = "Save TP-Link login";
  const clearLogin = document.createElement("button");
  clearLogin.className = "btn";
  clearLogin.type = "button";
  clearLogin.textContent = "Clear TP-Link login";
  clearLogin.addEventListener("click", async () => {
    applyPayload(await api("/api/plugs/account", { method: "PUT", body: { clear: true } }));
    toast("TP-Link login cleared");
  });
  login.append(email, password, saveLogin, clearLogin);
  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      applyPayload(await api("/api/plugs/account", {
        method: "PUT",
        body: { username: email.value.trim(), password: password.value },
      }));
      password.value = "";
      toast("TP-Link login saved");
    } catch (err) {
      toast(err.message || "Could not save the TP-Link login");
    }
  });
  root.append(login);
  const addForm = document.createElement("form");
  addForm.className = "add-row";
  addForm.id = "plug-add-form";
  const ip = document.createElement("input");
  ip.id = "plug-ip";
  ip.placeholder = "Add plug by IP, for example 192.168.1.159";
  ip.ariaLabel = "Plug IP address";
  const add = document.createElement("button");
  add.className = "btn";
  add.type = "submit";
  add.textContent = "Add plug";
  addForm.append(ip, add);
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      applyPayload(await api("/api/plugs/add", { method: "POST", body: { host: ip.value.trim() } }));
      ip.value = "";
      toast(current.plugs?.notice || "Plug added");
    } catch (err) {
      toast(err.message || "The plug did not answer.");
    }
  });
  root.append(addForm);
  if (plugAction && Date.now() - plugAction.at < 2500) {
    const status = document.createElement("p");
    status.id = "plug-action-status";
    status.className = "muted";
    status.textContent = plugAction.text;
    root.append(status);
  }

  for (const slot of ["1", "2", "3"]) {
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("p");
    const assigned = plugs.assignments?.[slot];
    const device = (plugs.devices || []).find((item) => item.id === assigned);
    const state = device ? (device.on === true ? "On" : device.on === false ? "Off" : "—") : "No plug";
    title.textContent = `${displayLabel(slot, current.displays?.count)} · ${state}`;
    const select = document.createElement("select");
    select.ariaLabel = `Plug for display ${slot}`;
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No plug";
    select.append(none);
    for (const item of plugs.devices || []) {
      const option = document.createElement("option");
      option.value = item.id;
      const loginNote = item.needsLogin ? ", needs TP-Link login" : "";
      option.textContent = item.model ? `${item.name} (${item.model}${loginNote})` : `${item.name}${loginNote}`;
      if (item.id === assigned) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", async () => {
      applyPayload(await api("/api/plugs/assignments", {
        method: "PUT",
        body: { [slot]: select.value || null },
      }));
      toast("Plug assignment saved");
    });
    const actions = document.createElement("div");
    actions.className = "theme-toggle";
    const on = document.createElement("button");
    on.type = "button";
    on.className = "btn";
    on.textContent = "On";
    on.disabled = !assigned;
    on.addEventListener("click", async () => {
      const label = displayLabel(slot, current.displays?.count);
      try {
        const payload = await api(`/api/plugs/${slot}/power`, { method: "POST", body: { on: true } });
        notePlugAction(`${label} turned on`, true);
        applyPayload(payload);
      } catch (err) {
        notePlugAction(err.message || "The plug did not answer.", false);
        renderPlugs();
      }
    });
    const off = document.createElement("button");
    off.type = "button";
    off.className = "btn";
    off.textContent = "Off";
    off.disabled = !assigned;
    off.addEventListener("click", async () => {
      const label = displayLabel(slot, current.displays?.count);
      try {
        const payload = await api(`/api/plugs/${slot}/power`, { method: "POST", body: { on: false } });
        notePlugAction(`${label} turned off`, true);
        applyPayload(payload);
      } catch (err) {
        notePlugAction(err.message || "The plug did not answer.", false);
        renderPlugs();
      }
    });
    actions.append(on, off);
    card.append(title, select, actions);
    root.append(card);
  }

  const schedule = plugs.schedule || {};
  const form = document.createElement("form");
  form.className = "add-row";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = Boolean(schedule.enabled);
  enabled.id = "plug-schedule";
  const label = document.createElement("label");
  label.htmlFor = "plug-schedule";
  label.textContent = "Schedule";
  const onTime = document.createElement("input");
  onTime.type = "time";
  onTime.value = schedule.onTime || "10:00";
  onTime.ariaLabel = "Plugs on at";
  const offTime = document.createElement("input");
  offTime.type = "time";
  offTime.value = schedule.offTime || "22:00";
  offTime.ariaLabel = "Plugs off at";
  const save = document.createElement("button");
  save.className = "btn";
  save.type = "submit";
  save.textContent = "Save schedule";
  form.append(enabled, label, onTime, offTime, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    applyPayload(await api("/api/plugs/schedule", {
      method: "PUT",
      body: { enabled: enabled.checked, onTime: onTime.value, offTime: offTime.value },
    }));
    toast("Plug schedule saved");
  });
  root.append(form);
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Example: on at open, off at close. The PC stays plugged into the wall, not a Kasa plug.";
  root.append(hint);
}

function renderMedia() {
  const root = document.getElementById("media-root");
  if (!root) return;
  root.replaceChildren();
  const media = current.media || { videos: [] };
  const form = document.createElement("form");
  form.className = "stack";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "video/mp4,video/webm,video/quicktime,.mp4,.m4v,.webm,.mov,.mkv";
  file.required = true;
  const title = document.createElement("input");
  title.placeholder = "Title";
  const folder = document.createElement("select");
  for (const [value, label] of [["library", "Library"], ["halloween", "Halloween"], ["christmas", "Christmas"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    folder.append(option);
  }
  const tags = document.createElement("input");
  tags.placeholder = "Tags, comma separated";
  const upload = document.createElement("button");
  upload.className = "btn primary";
  upload.type = "submit";
  upload.textContent = "Upload video";
  form.append(file, title, folder, tags, upload);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const chosen = file.files?.[0];
    if (!chosen) return;
    upload.disabled = true;
    try {
      const res = await fetch("/api/media", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": chosen.type || "application/octet-stream",
          "x-filename": chosen.name,
          "x-title": title.value || chosen.name,
          "x-folder": folder.value,
          "x-tags": tags.value,
          "x-all-ages": "true",
          "x-in-rotation": "false",
          "x-loop": "true",
        },
        body: chosen,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error || "Upload failed");
        return;
      }
      applyPayload(data);
      form.reset();
      toast("Video saved");
    } finally {
      upload.disabled = false;
    }
  });
  root.append(form);

  const playing = current.playback;
  if (playing) {
    const now = document.createElement("p");
    now.className = "muted";
    now.textContent = `Playing ${playing.title} (${playing.mode}) on ${playing.slots.join(", ")}.`;
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn danger";
    stop.textContent = "Stop video";
    stop.addEventListener("click", async () => {
      applyPayload(await api("/api/media/stop", { method: "POST" }));
      toast("Video stopped");
    });
    root.append(now, stop);
  }

  for (const video of media.videos || []) {
    const card = document.createElement("div");
    card.className = "card";
    const heading = document.createElement("p");
    heading.textContent = `${video.title} · ${video.folder}`;
    const tagLine = document.createElement("p");
    tagLine.className = "muted";
    tagLine.textContent = video.tags?.length ? video.tags.join(", ") : "No tags";
    const flags = document.createElement("div");
    flags.className = "theme-toggle";
    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.className = `btn${video.inRotation ? " active" : ""}`;
    rotate.textContent = video.inRotation ? "In rotation" : "Add to rotation";
    rotate.addEventListener("click", async () => {
      applyPayload(await api(`/api/media/${video.id}`, { method: "PUT", body: { inRotation: !video.inRotation } }));
    });
    flags.append(rotate);
    const playRow = document.createElement("div");
    playRow.className = "choice-row";
    const playOne = document.createElement("button");
    playOne.type = "button";
    playOne.className = "btn primary";
    playOne.textContent = "Play here";
    playOne.addEventListener("click", async () => {
      applyPayload(await api("/api/media/play", { method: "POST", body: { id: video.id, mode: "one", slot: presentSlot } }));
      toast("Playing");
    });
    const playSync = document.createElement("button");
    playSync.type = "button";
    playSync.className = "btn";
    playSync.textContent = "Sync all";
    playSync.addEventListener("click", async () => {
      applyPayload(await api("/api/media/play", { method: "POST", body: { id: video.id, mode: "sync" } }));
    });
    const playSpan = document.createElement("button");
    playSpan.type = "button";
    playSpan.className = "btn";
    playSpan.textContent = "Span all";
    playSpan.addEventListener("click", async () => {
      applyPayload(await api("/api/media/play", { method: "POST", body: { id: video.id, mode: "span" } }));
    });
    playRow.append(playOne, playSync, playSpan);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn ghost compact";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      applyPayload(await api(`/api/media/${video.id}`, { method: "DELETE" }));
      toast("Video deleted");
    });
    card.append(heading, tagLine, flags, playRow, remove);
    root.append(card);
  }
}

function assignedTvsOn() {
  const plugs = current.plugs || {};
  const ids = new Set(Object.values(plugs.assignments || {}).filter(Boolean));
  const devices = (plugs.devices || []).filter((device) => ids.has(device.id));
  if (!devices.length) return null;
  if (devices.every((device) => device.on === true)) return true;
  if (devices.some((device) => device.on === true)) return true;
  if (devices.some((device) => device.on === false)) return false;
  return null;
}

function renderTvs() {
  const button = document.getElementById("tvs-toggle");
  if (!button) return;
  const on = assignedTvsOn();
  button.textContent = on === true ? "TVs On" : on === false ? "TVs Off" : "TVs";
  button.classList.toggle("primary", on === true);
  button.setAttribute("aria-pressed", on === true ? "true" : "false");
}

function render() {
  applyTheme(current.state?.theme);
  renderPresent();
  renderAirplay();
  renderDisplays();
  renderPlugs();
  renderMedia();
  renderRotation();
  renderOpdbHelp();
  renderSlots();
  renderBoardSelect();
  renderBoardEditor();
  renderScoreQueue();
  renderArchive();
  renderYoutube();
  renderPhotos();
  renderAdmin();
  renderAccess();
  renderTvs();
  fillSlogans();
}

function fillSlogans() {
  const slogans = current.slogans || {};
  for (const key of ["pinnacle", "halloween", "christmas"]) {
    const input = document.getElementById(`slogan-${key}`);
    if (input && document.activeElement !== input) input.value = slogans[key] || "";
  }
}

function showApp() {
  loginEl.hidden = true;
  appEl.hidden = false;
}

function showTab(name) {
  if (navigator.vibrate) navigator.vibrate(8);
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== name;
  }
  localStorage.setItem("pl-admin-tab", name);
  if (name === "photos") renderPhotos();
  if (name === "settings") {
    renderAdmin();
    renderAccess();
  }
}

async function boot() {
  const auth = await api("/api/auth");
  if (!auth.ok) return;
  showApp();
  applyPayload(await api("/api/state"));
  showTab(localStorage.getItem("pl-admin-tab") || "screens");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  try {
    const session = await api("/api/login", { method: "POST", body: { pin: pinInput.value, name: "Admin iPad" } });
    if (session.token) localStorage.setItem("pl-admin-device", session.token);
    showApp();
    applyPayload(await api("/api/state"));
  } catch {
    loginError.hidden = false;
  }
});

document.getElementById("logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  localStorage.removeItem("pl-admin-device");
  loginEl.hidden = false;
  appEl.hidden = true;
  pinInput.value = "";
});

document.getElementById("theme-pinnacle").addEventListener("click", async () => {
  applyPayload(await api("/api/theme", { method: "PUT", body: { theme: "pinnacle" } }));
});

document.getElementById("theme-halloween").addEventListener("click", async () => {
  applyPayload(await api("/api/theme", { method: "PUT", body: { theme: "halloween" } }));
  toast("Halloween theme on");
});

document.getElementById("theme-christmas").addEventListener("click", async () => {
  applyPayload(await api("/api/theme", { method: "PUT", body: { theme: "christmas" } }));
  toast("Christmas theme on");
});

document.getElementById("rotate-all")?.addEventListener("click", async () => {
  applyPayload(await api("/api/displays", {
    method: "PUT",
    body: {
      screens: {
        1: { content: "rotation" },
        2: { content: "rotation" },
        3: { content: "rotation" },
      },
    },
  }));
  toast("All screens are rotating");
});

document.getElementById("guest-toggle")?.addEventListener("click", () => {
  const view = document.getElementById("guest-view");
  const frame = document.getElementById("guest-frame");
  if (!view || !frame) return;
  if (!frame.src || frame.src === "about:blank") frame.src = "/?from=admin";
  view.hidden = false;
});

document.getElementById("guest-back")?.addEventListener("click", () => {
  const view = document.getElementById("guest-view");
  if (view) view.hidden = true;
});

boardSelect.addEventListener("change", () => {
  selectedBoardId = boardSelect.value;
  render();
});

document.getElementById("manual-machine")?.addEventListener("submit", async (event) => {
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
    if (message.type === "kiosk" && message.kiosk && !appEl.hidden) {
      current.kiosk = message.kiosk;
      const order = document.getElementById("monitor-order");
      const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if (order && !typing) renderMonitorOrder(order);
      return;
    }
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

function renderScoreQueue() {
  const root = document.getElementById("score-queue");
  if (!root) return;
  root.replaceChildren();
  const pending = (current.state?.scoreSubmissions || []).filter((row) => row.status === "pending");
  if (!pending.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No scores waiting.";
    root.append(empty);
    return;
  }
  for (const row of pending) {
    const card = document.createElement("article");
    card.className = "card";
    const board = (current.state.leaderboards || []).find((item) => item.id === row.boardId);
    const copy = document.createElement("p");
    copy.textContent = `${row.name} · ${Number(row.score).toLocaleString("en-US")} on ${board?.name || "a machine"}`;
    card.append(copy);
    if (row.proofFile) {
      const img = document.createElement("img");
      img.src = `/media/score-proofs/${row.proofFile}`;
      img.alt = "Score photo";
      img.style.width = "120px";
      card.append(img);
    }
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "btn primary";
    approve.textContent = "Approve";
    approve.addEventListener("click", async () => {
      applyPayload(await api(`/api/scores/${row.id}/approve`, { method: "POST", body: { showPhoto: true } }));
      toast("Score approved");
    });
    const privateApprove = document.createElement("button");
    privateApprove.type = "button";
    privateApprove.className = "btn";
    privateApprove.textContent = "Approve, keep photo private (verification only)";
    privateApprove.addEventListener("click", async () => {
      applyPayload(await api(`/api/scores/${row.id}/approve`, { method: "POST", body: { showPhoto: false } }));
      toast("Score approved. Photo stays private.");
    });
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "btn";
    reject.textContent = "Reject";
    reject.addEventListener("click", async () => {
      applyPayload(await api(`/api/scores/${row.id}/reject`, { method: "POST" }));
    });
    card.append(approve, privateApprove, reject);
    root.append(card);
  }
}

function renderArchive() {
  const root = document.getElementById("archive-root");
  if (!root) return;
  root.replaceChildren();
  const boards = current.state?.archivedLeaderboards || [];
  if (!boards.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Nothing archived.";
    root.append(empty);
    return;
  }
  for (const board of boards) {
    const card = document.createElement("article");
    card.className = "card";
    const copy = document.createElement("p");
    copy.textContent = `${board.name} · ${board.rows?.length || 0} scores`;
    card.append(copy);
    if (board.kind === "machine" && board.opdbId) {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn";
      restore.textContent = "Restore";
      restore.addEventListener("click", async () => {
        applyPayload(await api(`/api/leaderboards/${board.id}/restore`, { method: "POST" }));
        toast("Board restored");
      });
      card.append(restore);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete archived board ${board.name}?`)) return;
      applyPayload(await api(`/api/leaderboards/${board.id}/archive`, { method: "DELETE" }));
    });
    card.append(remove);
    root.append(card);
  }
}


function openPhotoLightbox(url, filename) {
  let box = document.getElementById("photo-lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "photo-lightbox";
    box.className = "lightbox";
    box.hidden = true;
    box.innerHTML = '<button type="button" class="lightbox-close" aria-label="Close">×</button><img alt=""><a class="btn download">Download</a>';
    box.querySelector(".lightbox-close").addEventListener("click", () => { box.hidden = true; });
    document.body.append(box);
  }
  const img = box.querySelector("img");
  const link = box.querySelector("a");
  img.src = url;
  img.alt = filename || "Guest photo";
  link.href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
  link.download = filename || "photo.jpg";
  box.hidden = false;
}

function renderYoutube() {
  const root = document.getElementById("youtube-root");
  if (!root || !current.youtube) return;
  const theme = current.state?.theme || "pinnacle";
  root.replaceChildren();
  for (const item of current.youtube[theme] || []) {
    const row = document.createElement("div");
    row.className = "card";
    row.textContent = `${item.title} (${item.kind})`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn ghost compact";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      applyPayload(await api("/api/youtube", { method: "DELETE", body: { theme, id: item.id, kind: item.kind } }));
    });
    row.append(remove);
    root.append(row);
  }
}

async function renderPhotos() {
  const root = document.getElementById("photos-root");
  if (!root || document.getElementById("app").hidden) return;
  let data = { photos: [], settings: current.guest || {} };
  try {
    data = await api("/api/guest-photos");
  } catch {
    return;
  }
  root.replaceChildren();
  const auto = document.createElement("button");
  auto.type = "button";
  auto.className = `btn${data.settings?.autoApprove ? " active" : ""}`;
  auto.textContent = data.settings?.autoApprove ? "Auto-approve on" : "Auto-approve off";
  auto.addEventListener("click", async () => {
    applyPayload(await api("/api/guest-photos/settings", { method: "PUT", body: { autoApprove: !data.settings?.autoApprove } }));
    renderPhotos();
  });
  const downloadAll = document.createElement("a");
  downloadAll.className = "btn";
  downloadAll.href = "/api/guest-photos/zip";
  downloadAll.textContent = "Download all";
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = `btn${data.settings?.paused ? " active" : ""}`;
  pause.textContent = data.settings?.paused ? "Uploads paused" : "Pause uploads";
  pause.addEventListener("click", async () => {
    applyPayload(await api("/api/guest-photos/settings", { method: "PUT", body: { paused: !data.settings?.paused } }));
    renderPhotos();
  });
  root.append(auto, pause, downloadAll);
  for (const photo of data.photos || []) {
    if (photo.status === "rejected") continue;
    const card = document.createElement("article");
    card.className = "card";
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = photo.caption || "Guest photo";
    img.style.width = "120px";
    const copy = document.createElement("p");
    const when = photo.createdAt ? new Date(photo.createdAt).toLocaleString() : "";
    copy.textContent = `${photo.status}: ${[when, photo.guestName, photo.caption].filter(Boolean).join(" — ") || "No caption"}`;
    img.addEventListener("click", () => openPhotoLightbox(photo.url, `${photo.id}.jpg`));
    img.style.cursor = "pointer";
    card.append(img, copy);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!confirm("Delete this photo permanently?")) return;
      await api(`/api/guest-photos/${photo.id}`, { method: "DELETE" });
      renderPhotos();
    });
    card.append(remove);
    if (photo.status !== "archived") {
      const archive = document.createElement("button");
      archive.type = "button";
      archive.className = "btn";
      archive.textContent = "Archive";
      archive.addEventListener("click", async () => {
        await api(`/api/guest-photos/${photo.id}/archive`, { method: "POST" });
        renderPhotos();
      });
      card.append(archive);
    } else {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn";
      restore.textContent = "Restore";
      restore.addEventListener("click", async () => {
        await api(`/api/guest-photos/${photo.id}/restore`, { method: "POST" });
        renderPhotos();
      });
      card.append(restore);
    }
    if (photo.status === "pending") {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "btn primary";
      approve.textContent = "Approve";
      approve.addEventListener("click", async () => {
        await api(`/api/guest-photos/${photo.id}/approve`, { method: "POST" });
        renderPhotos();
      });
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "btn";
      reject.textContent = "Reject";
      reject.addEventListener("click", async () => {
        await api(`/api/guest-photos/${photo.id}/reject`, { method: "POST" });
        renderPhotos();
      });
      card.append(approve, reject);
    }
    root.append(card);
  }
}

function renderAccess() {
  const status = document.getElementById("public-access-status");
  if (!status || document.getElementById("app").hidden) return;
  const access = current.publicAccess || {};
  const guest = current.guest || {};
  document.getElementById("public-access-on")?.classList.toggle("active", access.enabled === true);
  document.getElementById("public-access-off")?.classList.toggle("active", access.enabled !== true);
  document.getElementById("pinboard-on")?.classList.toggle("active", guest.pinboard !== false);
  document.getElementById("pinboard-off")?.classList.toggle("active", guest.pinboard === false);
  const cloudflare = document.getElementById("public-cloudflare");
  if (cloudflare && document.activeElement !== cloudflare) cloudflare.checked = access.cloudflare === true;
  const url = access.url ? access.url : "";
  status.textContent = access.enabled
    ? (url ? `${access.detail || "Public"} · ${url}` : (access.detail || "Waiting for Tailscale Funnel."))
    : "Off. Guests use the venue WiFi.";
}

async function renderAdmin() {
  const version = document.getElementById("version-line");
  if (!version || document.getElementById("app").hidden) return;
  const updates = current.updates || {};
  const commit = updates.commit ? ` · ${updates.commit}` : "";
  version.textContent = `Version ${current.version || ""}${commit}`;
  const status = document.getElementById("update-status");
  if (status) {
    status.textContent = updates.lastAt
      ? `Last update ${updates.lastAt}: ${updates.lastResult || "unknown"}. ${updates.lastDetail || ""}`
      : "No update has run yet.";
  }
  const enabled = document.getElementById("update-enabled");
  const nightly = document.getElementById("update-nightly");
  if (enabled && document.activeElement !== enabled) enabled.checked = updates.enabled !== false;
  if (nightly && document.activeElement !== nightly && updates.nightlyAt) nightly.value = updates.nightlyAt;
}

for (const button of document.querySelectorAll("[data-tab]")) {
  button.addEventListener("click", () => showTab(button.dataset.tab));
}
document.getElementById("youtube-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("youtube-input");
  applyPayload(await api("/api/youtube", {
    method: "POST",
    body: { theme: current.state?.theme || "pinnacle", input: input.value },
  }));
  input.value = "";
});
document.getElementById("pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await api("/api/pin", { method: "PUT", body: { pin: document.getElementById("new-pin").value } });
  toast("PIN changed");
});
document.getElementById("reset-pin").addEventListener("click", async () => {
  await api("/api/pin/reset", { method: "POST" });
  toast("PIN reset to the default");
});
document.getElementById("slogan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  applyPayload(await api("/api/slogans", {
    method: "PUT",
    body: {
      pinnacle: document.getElementById("slogan-pinnacle").value,
      halloween: document.getElementById("slogan-halloween").value,
      christmas: document.getElementById("slogan-christmas").value,
    },
  }));
  toast("Clock slogans saved");
});
document.getElementById("update-settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  const saved = await api("/api/updates/settings", {
    method: "PUT",
    body: {
      enabled: document.getElementById("update-enabled").checked,
      nightlyAt: document.getElementById("update-nightly").value || "03:17",
    },
  });
  if (saved.updates) current.updates = { ...current.updates, ...saved.updates };
  toast(saved.note || "Update schedule saved");
  renderAdmin();
});
async function savePublic(patch) {
  applyPayload(await api("/api/public-access", { method: "PUT", body: patch }));
  toast("Public access saved");
}

document.getElementById("public-access-on")?.addEventListener("click", () => savePublic({ enabled: true }));
document.getElementById("public-access-off")?.addEventListener("click", () => savePublic({ enabled: false }));
document.getElementById("public-cloudflare")?.addEventListener("change", (event) => {
  savePublic({ cloudflare: event.target.checked });
});
document.getElementById("pinboard-on")?.addEventListener("click", async () => {
  applyPayload(await api("/api/guest-photos/settings", { method: "PUT", body: { pinboard: true } }));
  toast("Pinboard on");
});
document.getElementById("pinboard-off")?.addEventListener("click", async () => {
  applyPayload(await api("/api/guest-photos/settings", { method: "PUT", body: { pinboard: false } }));
  toast("Pinboard off");
});
document.getElementById("tvs-toggle")?.addEventListener("click", async () => {
  const turningOn = assignedTvsOn() !== true;
  try {
    applyPayload(await api("/api/plugs/power", { method: "POST", body: { on: turningOn } }));
    toast(turningOn ? "TVs on" : "TVs off");
  } catch (err) {
    toast(err.message || "The plug did not answer.");
  }
  renderTvs();
});
document.getElementById("update-now").addEventListener("click", async () => {
  const result = await api("/api/updates/now", { method: "POST" });
  toast(result.note || `Version ${result.version}`);
});

const installHint = document.getElementById("install-hint");
const standalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
if (installHint && !standalone) installHint.hidden = false;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin" }).catch(() => {});
}

boot().catch(() => {});
connect();
