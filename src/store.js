const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { AMENITY_IDS } = require("./amenities");
const { normalizeRotation, ROTATION_ITEM_IDS, clampInterval } = require("./playlist");

const SLOT_IDS = ["1", "2", "3"];
const CONTENTS = ["logos", "amenities", "leaderboard", "pinboard", "video"];
const THEMES = ["pinnacle", "halloween", "christmas"];
const BLACK_CONTENT = new Set(["off", "black", "dark"]);
const LEGACY_CONTENT = {
  pinnacle: "logos",
  "pinball-land": "logos",
  arcade: "amenities",
  photos: "pinboard",
  collage: "pinboard",
  venue: "amenities",
  bar: "amenities",
  pool: "amenities",
  "amenity-arcade": "amenities",
  "amenity-oasis": "amenities",
  "amenity-events": "amenities",
};

const LOCKED_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_BACKOFF_MS = [50, 100, 200, 400];

function id() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockedRename(err) {
  return Boolean(err && LOCKED_RENAME.has(err.code));
}

// Windows rename over an existing file returns EPERM/EBUSY when Defender or the
// indexer still has state.json open. Retry, then copy over the destination.
async function replaceFile(tmp, dest, fsImpl = fs, { delays = RENAME_BACKOFF_MS, sleepFn = sleep } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fsImpl.rename(tmp, dest);
      return;
    } catch (err) {
      if (!isLockedRename(err)) throw err;
      lastErr = err;
      if (attempt < delays.length) await sleepFn(delays[attempt]);
    }
  }
  let fallbackErr = lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      await fsImpl.copyFile(tmp, dest);
      try {
        await fsImpl.unlink(tmp);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      return;
    } catch (err) {
      fallbackErr = err;
      if (!isLockedRename(err) || attempt >= delays.length) {
        if (lastErr && lastErr !== err) err.renameError = lastErr;
        throw err;
      }
      await sleepFn(delays[attempt]);
    }
  }
  throw fallbackErr;
}

async function removeStaleTemp(filePath, fsImpl = fs) {
  try {
    await fsImpl.unlink(`${filePath}.tmp`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`Could not remove stale temp file (${filePath}.tmp): ${err.message}`);
    }
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  const halloweenId = id();
  return {
    theme: "pinnacle",
    blackout: false,
    rotation: normalizeRotation({
      enabled: true,
      startedAt: Date.now(),
      items: Object.fromEntries(ROTATION_ITEM_IDS.map((key) => [key, true])),
    }),
    slots: {
      1: { content: "logos", leaderboardId: halloweenId },
      2: { content: "amenities", leaderboardId: halloweenId },
      3: { content: "leaderboard", leaderboardId: halloweenId },
    },
    leaderboards: [
      {
        id: halloweenId,
        name: "Halloween party",
        kind: "event",
        inRotation: true,
        rows: [
          { id: id(), name: "Sam", score: 2450000 },
          { id: id(), name: "Riley", score: 1810000 },
          { id: id(), name: "Jordan", score: 960000 },
        ],
      },
    ],
  };
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") {
    return { id: id(), name: "", score: 0 };
  }
  const score = Number.parseInt(row.score, 10);
  return {
    id: typeof row.id === "string" && row.id ? row.id : id(),
    name: String(row.name || "").trim(),
    score: Number.isFinite(score) ? score : 0,
  };
}

function normalizeLeaderboard(board) {
  if (!board || typeof board !== "object") {
    return {
      id: id(),
      name: "Untitled event",
      kind: "event",
      inRotation: true,
      opdbId: null,
      manufacturer: "",
      year: "",
      artFile: null,
      videoUrl: null,
      rows: [],
    };
  }
  const kind = board.kind === "machine" ? "machine" : "event";
  const nameDefault = kind === "machine" ? "Untitled machine" : "Untitled event";
  return {
    id: typeof board.id === "string" && board.id ? board.id : id(),
    name: String(board.name || nameDefault).trim() || nameDefault,
    kind,
    inRotation: board.inRotation !== false,
    opdbId: board.opdbId ? String(board.opdbId) : null,
    manufacturer: String(board.manufacturer || "").trim(),
    year: String(board.year || "").trim(),
    artFile: board.artFile ? String(board.artFile) : null,
    videoUrl: board.videoUrl ? String(board.videoUrl) : null,
    rows: Array.isArray(board.rows) ? board.rows.map(normalizeRow) : [],
  };
}

function normalizeContent(content) {
  if (BLACK_CONTENT.has(content)) return "logos";
  if (LEGACY_CONTENT[content]) return LEGACY_CONTENT[content];
  return CONTENTS.includes(content) ? content : null;
}

function normalizeTheme(theme) {
  return THEMES.includes(theme) ? theme : "pinnacle";
}

function normalizeSlot(slot, fallbackLeaderboardId) {
  const content = normalizeContent(slot?.content) || "logos";
  const leaderboardId =
    typeof slot?.leaderboardId === "string" && slot.leaderboardId
      ? slot.leaderboardId
      : fallbackLeaderboardId;
  return { content, leaderboardId };
}

function slotWasBlack(rawSlots) {
  if (!rawSlots || typeof rawSlots !== "object") return false;
  return SLOT_IDS.some((slotId) => BLACK_CONTENT.has(rawSlots[slotId]?.content));
}

function normalizeState(raw) {
  const seeded = defaultState();
  const incoming = raw && typeof raw === "object" ? raw : {};
  const leaderboards = Array.isArray(incoming.leaderboards)
    ? incoming.leaderboards.map(normalizeLeaderboard)
    : seeded.leaderboards;
  const fallbackId = leaderboards[0]?.id || null;
  const slots = {};
  for (const slotId of SLOT_IDS) {
    slots[slotId] = normalizeSlot(incoming.slots?.[slotId] || seeded.slots[slotId], fallbackId);
  }
  const rotation = normalizeRotation(incoming.rotation);
  if (incoming.blackout || slotWasBlack(incoming.slots)) rotation.enabled = true;
  return {
    theme: normalizeTheme(incoming.theme ?? seeded.theme),
    blackout: false,
    rotation,
    slots,
    leaderboards,
  };
}

class Store {
  constructor(filePath, state) {
    this.filePath = filePath;
    this.state = normalizeState(state);
    this.listeners = new Set();
  }

  static async load(filePath) {
    await removeStaleTemp(filePath);
    let parsed = null;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`Could not read state file (${filePath}), starting from defaults:`, err.message);
      }
    }
    const store = new Store(filePath, parsed || defaultState());
    await store.persist();
    return store;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState() {
    return clone(this.state);
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await replaceFile(tmp, this.filePath);
  }

  async commit() {
    await this.persist();
    const snapshot = this.getState();
    for (const fn of this.listeners) {
      fn(snapshot);
    }
    return snapshot;
  }

  findBoard(boardId) {
    return this.state.leaderboards.find((board) => board.id === boardId);
  }

  findRow(board, rowId) {
    return board.rows.find((row) => row.id === rowId);
  }

  bumpRotationClock() {
    this.state.rotation.startedAt = Date.now();
  }

  async setSlot(slotId, patch) {
    if (!SLOT_IDS.includes(String(slotId))) {
      throw Object.assign(new Error("Unknown slot"), { status: 404 });
    }
    const slot = this.state.slots[slotId];
    if (patch.content !== undefined) {
      const content = normalizeContent(patch.content);
      if (!content) {
        throw Object.assign(new Error("Unknown slot content"), { status: 400 });
      }
      slot.content = content;
      if (BLACK_CONTENT.has(patch.content)) this.state.rotation.enabled = true;
    }
    if (patch.leaderboardId !== undefined) {
      if (patch.leaderboardId !== null && !this.findBoard(patch.leaderboardId)) {
        throw Object.assign(new Error("Unknown leaderboard"), { status: 400 });
      }
      slot.leaderboardId = patch.leaderboardId;
    }
    return this.commit();
  }

  async blackAll() {
    this.state.blackout = false;
    this.state.rotation.enabled = true;
    return this.commit();
  }

  async resumeWall() {
    this.state.blackout = false;
    this.state.rotation.enabled = true;
    return this.commit();
  }

  async setTheme(theme) {
    if (!THEMES.includes(theme)) {
      throw Object.assign(new Error("theme must be pinnacle, halloween, or christmas"), { status: 400 });
    }
    this.state.theme = theme;
    return this.commit();
  }

  async setRotation(patch = {}) {
    if (patch.enabled !== undefined) {
      this.state.rotation.enabled = Boolean(patch.enabled);
      if (this.state.rotation.enabled) {
        this.state.blackout = false;
      }
    }
    if (patch.intervalSec !== undefined) {
      this.state.rotation.intervalSec = clampInterval(patch.intervalSec);
    }
    if (patch.items && typeof patch.items === "object") {
      for (const key of ROTATION_ITEM_IDS) {
        if (typeof patch.items[key] === "boolean") {
          this.state.rotation.items[key] = patch.items[key];
        }
      }
    }
    this.bumpRotationClock();
    return this.commit();
  }

  async createLeaderboard(name, extra = {}) {
    const board = normalizeLeaderboard({
      id: id(),
      name: name || (extra.kind === "machine" ? "New machine" : "New event"),
      kind: extra.kind === "machine" ? "machine" : "event",
      inRotation: extra.inRotation !== false,
      opdbId: extra.opdbId || null,
      manufacturer: extra.manufacturer || "",
      year: extra.year || "",
      artFile: extra.artFile || null,
      videoUrl: extra.videoUrl || null,
      rows: extra.rows || [],
    });
    this.state.leaderboards.push(board);
    this.bumpRotationClock();
    return this.commit();
  }

  async updateLeaderboard(boardId, patch = {}) {
    const board = this.findBoard(boardId);
    if (!board) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    if (patch.name !== undefined) {
      board.name = String(patch.name || "").trim() || board.name;
    }
    if (patch.inRotation !== undefined) {
      board.inRotation = Boolean(patch.inRotation);
      this.bumpRotationClock();
    }
    if (patch.artFile !== undefined) {
      board.artFile = patch.artFile ? String(patch.artFile) : null;
    }
    if (patch.videoUrl !== undefined) {
      board.videoUrl = patch.videoUrl ? String(patch.videoUrl) : null;
    }
    if (patch.manufacturer !== undefined) {
      board.manufacturer = String(patch.manufacturer || "").trim();
    }
    if (patch.year !== undefined) {
      board.year = String(patch.year || "").trim();
    }
    if (patch.opdbId !== undefined) {
      board.opdbId = patch.opdbId ? String(patch.opdbId) : null;
    }
    return this.commit();
  }

  async renameLeaderboard(boardId, name) {
    return this.updateLeaderboard(boardId, { name });
  }

  async deleteLeaderboard(boardId) {
    const index = this.state.leaderboards.findIndex((board) => board.id === boardId);
    if (index === -1) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    this.state.leaderboards.splice(index, 1);
    const fallback = this.state.leaderboards[0]?.id || null;
    for (const slotId of SLOT_IDS) {
      if (this.state.slots[slotId].leaderboardId === boardId) {
        this.state.slots[slotId].leaderboardId = fallback;
      }
    }
    this.bumpRotationClock();
    return this.commit();
  }

  async clearLeaderboard(boardId) {
    const board = this.findBoard(boardId);
    if (!board) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    board.rows = [];
    return this.commit();
  }

  async addRow(boardId, { name, score }) {
    const board = this.findBoard(boardId);
    if (!board) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    board.rows.push(normalizeRow({ name, score }));
    return this.commit();
  }

  async updateRow(boardId, rowId, { name, score }) {
    const board = this.findBoard(boardId);
    if (!board) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    const row = this.findRow(board, rowId);
    if (!row) {
      throw Object.assign(new Error("Unknown row"), { status: 404 });
    }
    if (name !== undefined) {
      row.name = String(name || "").trim();
    }
    if (score !== undefined) {
      const parsed = Number.parseInt(score, 10);
      row.score = Number.isFinite(parsed) ? parsed : 0;
    }
    return this.commit();
  }

  async deleteRow(boardId, rowId) {
    const board = this.findBoard(boardId);
    if (!board) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    const index = board.rows.findIndex((row) => row.id === rowId);
    if (index === -1) {
      throw Object.assign(new Error("Unknown row"), { status: 404 });
    }
    board.rows.splice(index, 1);
    return this.commit();
  }

  async moveRow(boardId, rowId, direction) {
    const board = this.findBoard(boardId);
    if (!board) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    const index = board.rows.findIndex((row) => row.id === rowId);
    if (index === -1) {
      throw Object.assign(new Error("Unknown row"), { status: 404 });
    }
    const delta = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    if (!delta) {
      throw Object.assign(new Error("direction must be up or down"), { status: 400 });
    }
    const next = index + delta;
    if (next < 0 || next >= board.rows.length) {
      return this.getState();
    }
    const [row] = board.rows.splice(index, 1);
    board.rows.splice(next, 0, row);
    return this.commit();
  }
}

module.exports = {
  Store,
  replaceFile,
  removeStaleTemp,
  LOCKED_RENAME,
  RENAME_BACKOFF_MS,
  SLOT_IDS,
  CONTENTS,
  THEMES,
  AMENITY_IDS,
  LEGACY_CONTENT,
  defaultState,
  normalizeState,
  normalizeContent,
  normalizeTheme,
};
