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

function displayLabel(slot, count) {
  const n = Number(slot);
  const total = Number(count) || 3;
  if (total <= 1) return "Screen";
  if (total === 2) return n === 1 ? "Left" : "Right";
  return { 1: "Left", 2: "Center", 3: "Right" }[n] || `Screen ${n}`;
}

const DISPLAY_CONTENT = [
  { id: "rotation", label: "Rotation" },
  { id: "pinnacle", label: "Pinnacle Group" },
  { id: "pinball-land", label: "Entertainment Center" },
  { id: "amenity-arcade", label: "2-story arcade" },
  { id: "amenity-oasis", label: "Outdoor Oasis" },
  { id: "amenity-events", label: "Event options" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "off", label: "Black" },
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
  const count = displays.count || 3;
  root.replaceChildren();

  const countRow = document.createElement("div");
  countRow.className = "choice-row";
  for (const value of [1, 2, 3]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn${count === value ? " active" : ""}`;
    button.textContent = `${value} screen${value === 1 ? "" : "s"}`;
    button.addEventListener("click", () => saveDisplays({ count: value }).then(() => toast("Display count saved")));
    countRow.append(button);
  }
  root.append(countRow);

  const mirror = document.createElement("button");
  mirror.type = "button";
  mirror.className = `btn toggle${displays.mirror ? " active" : ""}`;
  mirror.textContent = displays.mirror ? "Mirroring screen 1 to all" : "Mirror one layout to all";
  mirror.addEventListener("click", () => {
    saveDisplays({ mirror: !displays.mirror }).then(() => toast(displays.mirror ? "Each screen can differ" : "Mirroring screen 1"));
  });
  root.append(mirror);

  for (const slot of ["1", "2", "3"]) {
    const screenCfg = displays.screens?.[slot] || { enabled: true, content: "rotation" };
    const layout = current.layout?.[slot] || screenCfg;
    const card = document.createElement("article");
    card.className = `slot-card screen-card${Number(slot) > count ? " dimmed" : ""}`;
    const title = document.createElement("h3");
    title.className = "slot-label";
    title.textContent = displayLabel(slot, count);
    card.append(title);

    if (Number(slot) > count) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Not in use until the display count includes it.";
      card.append(note);
    }

    const enable = document.createElement("button");
    enable.type = "button";
    enable.className = `btn toggle${screenCfg.enabled !== false ? " active" : ""}`;
    enable.textContent = screenCfg.enabled !== false ? "Enabled" : "Disabled";
    enable.addEventListener("click", () => {
      saveDisplays({ screens: { [slot]: { enabled: screenCfg.enabled === false } } }).then(() => toast("Display updated"));
    });
    card.append(enable);

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
    const airplay = document.createElement("button");
    airplay.type = "button";
    airplay.className = "btn";
    airplay.textContent = "AirPlay";
    airplay.addEventListener("click", () => startPresent({ source: "airplay" }));
    sources.append(share, airplay);
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

  if (current.airplay && current.airplay.ready === false) {
    const missing = document.createElement("p");
    missing.className = "muted";
    missing.textContent = "AirPlay helper is not installed on this PC yet. Browser share, URLs, and file upload still work. Setup is in PRESENTING.md.";
    root.append(missing);
  }
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

function render() {
  applyTheme(current.state?.theme);
  renderOffButton();
  renderPresent();
  renderDisplays();
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

boot().catch(() => {});
connect();
