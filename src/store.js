const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { AMENITY_IDS } = require("./amenities");
const { normalizeRotation, ROTATION_ITEM_IDS, clampInterval } = require("./playlist");
const { icaclsRepairCommand } = require("./paths");

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
const PERSIST_RETRY_MS = [1000, 2000, 5000, 10000, 30000];

function id() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockedRename(err) {
  return Boolean(err && LOCKED_RENAME.has(err.code));
}

function stateDir(filePath) {
  if (filePath.includes("\\") || /^[A-Za-z]:/.test(filePath)) return path.win32.dirname(filePath);
  return path.dirname(filePath);
}

function warnUnpersisted(filePath, err) {
  const code = err && err.code ? err.code : "EPERM";
  const detail = err && err.message ? `: ${err.message}` : "";
  console.warn(
    [
      `Could not write ${filePath} (${code}${detail}).`,
      "Pinball Land will keep running with this state in memory and retry the save.",
      "Likely causes:",
      "- state.json is owned by Administrators from an earlier elevated run",
      "- the file has the read-only attribute",
      "- another node process already has the file open",
      "- antivirus software is locking the file",
      "From an elevated Command Prompt, grant Users modify:",
      icaclsRepairCommand(stateDir(filePath)),
    ].join("\n")
  );
}

// A read-only attribute makes Windows refuse the replace with EPERM. Node maps
// that attribute to a missing owner-write bit; putting the bit back clears it.
async function clearReadOnly(dest, fsImpl) {
  if (typeof fsImpl.stat !== "function" || typeof fsImpl.chmod !== "function") return;
  let stat;
  try {
    stat = await fsImpl.stat(dest);
  } catch {
    return;
  }
  if (!stat || typeof stat.mode !== "number" || (stat.mode & 0o200) !== 0) return;
  try {
    await fsImpl.chmod(dest, stat.mode | 0o200);
  } catch {
    // Still try the replace. The direct write and the in-memory fallback cover this.
  }
}

async function writeDirectFallback(tmp, dest, fsImpl) {
  if (typeof fsImpl.readFile !== "function" || typeof fsImpl.open !== "function") return false;
  await clearReadOnly(dest, fsImpl);
  const data = await fsImpl.readFile(tmp);
  const handle = await fsImpl.open(dest, "w");
  try {
    if (typeof handle.writeFile === "function") await handle.writeFile(data);
    else await handle.write(data);
    if (typeof handle.sync === "function") await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsImpl.unlink(tmp);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.warn(`Saved ${dest} but could not remove ${tmp}: ${err && err.message ? err.message : err}`);
    }
  }
  return true;
}

function attachRenameError(err, renameError) {
  if (renameError && renameError !== err) err.renameError = renameError;
  return err;
}

// Windows rename over an existing file returns EPERM/EBUSY/EACCES when Defender,
// the indexer, or another node process still has state.json open, and also when
// the file is read-only or owned by Administrators. Retry, copy, then write the
// destination directly and fsync.
async function replaceFile(tmp, dest, fsImpl = fs, { delays = RENAME_BACKOFF_MS, sleepFn = sleep } = {}) {
  await clearReadOnly(dest, fsImpl);
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
      if (!isLockedRename(err)) throw attachRenameError(err, lastErr);
      if (attempt >= delays.length) break;
      await sleepFn(delays[attempt]);
    }
  }
  if (fallbackErr && isLockedRename(fallbackErr)) {
    try {
      const wrote = await writeDirectFallback(tmp, dest, fsImpl);
      if (wrote) return;
    } catch (err) {
      throw attachRenameError(err, lastErr);
    }
  }
  if (fallbackErr) throw attachRenameError(fallbackErr, lastErr);
  throw lastErr;
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
  return {
    theme: "pinnacle",
    blackout: false,
    rotation: normalizeRotation({
      enabled: true,
      startedAt: Date.now(),
      items: Object.fromEntries(ROTATION_ITEM_IDS.map((key) => [key, true])),
    }),
    slots: {
      1: { content: "logos", leaderboardId: null },
      2: { content: "amenities", leaderboardId: null },
      3: { content: "leaderboard", leaderboardId: null },
    },
    leaderboards: [],
    archivedLeaderboards: [],
    scoreSubmissions: [],
  };
}

function parseScore(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const digits = String(value ?? "").replace(/[,_\s]/g, "");
  if (!digits) return 0;
  const score = Number.parseInt(digits, 10);
  return Number.isFinite(score) ? score : 0;
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") {
    return { id: id(), name: "", score: 0 };
  }
  const proofFile = typeof row.proofFile === "string" && /^[0-9a-f-]{36}\.jpg$/i.test(row.proofFile) ? row.proofFile : null;
  return {
    id: typeof row.id === "string" && row.id ? row.id : id(),
    name: String(row.name || "").trim(),
    score: parseScore(row.score),
    proofFile,
    createdAt: Number(row.createdAt) > 0 ? Number(row.createdAt) : null,
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
    playfieldFile: board.playfieldFile ? String(board.playfieldFile) : null,
    logoFile: board.logoFile ? String(board.logoFile) : null,
    imageFiles: Array.isArray(board.imageFiles)
      ? board.imageFiles.map((file) => String(file)).filter((file) => file && !file.includes("..")).slice(0, 24)
      : [],
    videoUrl: board.videoUrl ? String(board.videoUrl) : null,
    rows: sortRows(Array.isArray(board.rows) ? board.rows.map(normalizeRow) : []),
    archivedAt: Number.isFinite(Number(board.archivedAt)) ? Number(board.archivedAt) : null,
  };
}

function sortRows(rows) {
  return [...rows].sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
}

function playerKey(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isMachineBoard(board) {
  return board?.kind === "machine" && Boolean(board.opdbId);
}

function normalizeSubmission(row) {
  if (!row || typeof row !== "object") return null;
  const status = row.status === "approved" || row.status === "rejected" ? row.status : "pending";
  return {
    id: typeof row.id === "string" && row.id ? row.id : id(),
    boardId: row.boardId ? String(row.boardId) : "",
    name: String(row.name || "").trim().slice(0, 40),
    score: parseScore(row.score),
    proofFile: row.proofFile ? String(row.proofFile) : null,
    status,
    createdAt: Number(row.createdAt) || Date.now(),
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
  const incomingBoards = Array.isArray(incoming.leaderboards)
    ? incoming.leaderboards.map(normalizeLeaderboard)
    : seeded.leaderboards;
  const archivedLeaderboards = Array.isArray(incoming.archivedLeaderboards)
    ? incoming.archivedLeaderboards.map(normalizeLeaderboard)
    : [];
  const seen = new Set(archivedLeaderboards.map((board) => board.id));
  const leaderboards = [];
  for (const board of incomingBoards) {
    board.rows = sortRows(board.rows);
    if (isMachineBoard(board)) {
      leaderboards.push(board);
    } else if (!seen.has(board.id)) {
      archivedLeaderboards.push({
        ...board,
        inRotation: false,
        archivedAt: board.archivedAt || Date.now(),
      });
      seen.add(board.id);
    }
  }
  const activeIds = new Set(leaderboards.map((board) => board.id));
  const fallbackId = leaderboards[0]?.id || null;
  const slots = {};
  for (const slotId of SLOT_IDS) {
    const slot = normalizeSlot(incoming.slots?.[slotId] || seeded.slots[slotId], fallbackId);
    if (slot.leaderboardId && !activeIds.has(slot.leaderboardId)) slot.leaderboardId = fallbackId;
    slots[slotId] = slot;
  }
  const rotation = normalizeRotation(incoming.rotation);
  if (incoming.blackout || slotWasBlack(incoming.slots)) rotation.enabled = true;
  const scoreSubmissions = Array.isArray(incoming.scoreSubmissions)
    ? incoming.scoreSubmissions.map(normalizeSubmission).filter((row) => row && row.boardId && row.name)
    : [];
  return {
    theme: normalizeTheme(incoming.theme ?? seeded.theme),
    blackout: false,
    rotation,
    slots,
    leaderboards,
    archivedLeaderboards,
    scoreSubmissions,
  };
}

class Store {
  constructor(filePath, state, options = {}) {
    this.filePath = filePath;
    this.state = normalizeState(state);
    this.listeners = new Set();
    this.scoreHits = new Map();
    this.fsImpl = options.fsImpl || fs;
    this.sleepFn = options.sleepFn || sleep;
    this.renameDelays = options.renameDelays || RENAME_BACKOFF_MS;
    this.retryDelays = options.retryDelays || PERSIST_RETRY_MS;
    this.unpersisted = false;
    this.lastPersistError = null;
    this.retryTimer = null;
    this.announcedPersistFailure = false;
  }

  static async load(filePath, options = {}) {
    const fsImpl = options.fsImpl || fs;
    await removeStaleTemp(filePath, fsImpl);
    let parsed = null;
    try {
      const raw = await fsImpl.readFile(filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error(`Could not read state file (${filePath}), starting from defaults:`, err.message);
      }
    }
    const store = new Store(filePath, parsed || defaultState(), options);
    try {
      await store.persist();
    } catch (err) {
      if (!isLockedRename(err)) throw err;
      store.notePersistFailure(err);
    }
    return store;
  }

  notePersistFailure(err) {
    this.unpersisted = true;
    this.lastPersistError = err;
    if (!this.announcedPersistFailure) {
      this.announcedPersistFailure = true;
      warnUnpersisted(this.filePath, err);
    }
    this.schedulePersistRetry();
  }

  schedulePersistRetry() {
    if (this.retryTimer) return;
    const delays = this.retryDelays.length ? this.retryDelays : [1000];
    let index = 0;
    const tick = async () => {
      this.retryTimer = null;
      try {
        await this.persist();
        console.warn(`Saved state after a permission error (${this.filePath}).`);
      } catch (err) {
        if (!isLockedRename(err)) {
          console.error(`Could not save state (${this.filePath}):`, err.message);
          return;
        }
        this.unpersisted = true;
        this.lastPersistError = err;
        const wait = delays[Math.min(index, delays.length - 1)];
        index += 1;
        this.retryTimer = setTimeout(tick, wait);
        if (typeof this.retryTimer.unref === "function") this.retryTimer.unref();
      }
    };
    this.retryTimer = setTimeout(tick, delays[0]);
    index = 1;
    if (typeof this.retryTimer.unref === "function") this.retryTimer.unref();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState() {
    return clone(this.state);
  }

  async persist() {
    const fsImpl = this.fsImpl;
    await fsImpl.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const body = JSON.stringify(this.state, null, 2);
    await fsImpl.writeFile(tmp, body, "utf8");
    await replaceFile(tmp, this.filePath, fsImpl, {
      delays: this.renameDelays,
      sleepFn: this.sleepFn,
    });
    this.unpersisted = false;
    this.lastPersistError = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async commit() {
    try {
      await this.persist();
    } catch (err) {
      if (isLockedRename(err)) this.notePersistFailure(err);
      throw err;
    }
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
    const opdbId = extra.opdbId ? String(extra.opdbId) : "";
    if (extra.kind !== "machine" || !opdbId) {
      throw Object.assign(new Error("Leaderboards are real pinball machines from OPDB"), { status: 400 });
    }
    const board = normalizeLeaderboard({
      id: id(),
      name: name || "New machine",
      kind: "machine",
      inRotation: extra.inRotation !== false,
      opdbId,
      manufacturer: extra.manufacturer || "",
      year: extra.year || "",
      artFile: extra.artFile || null,
      playfieldFile: extra.playfieldFile || null,
      logoFile: extra.logoFile || null,
      imageFiles: extra.imageFiles || [],
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
    if (patch.playfieldFile !== undefined) {
      board.playfieldFile = patch.playfieldFile ? String(patch.playfieldFile) : null;
    }
    if (patch.logoFile !== undefined) {
      board.logoFile = patch.logoFile ? String(patch.logoFile) : null;
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
    board.rows = sortRows(board.rows);
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
    if (score !== undefined) row.score = parseScore(score);
    board.rows = sortRows(board.rows);
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
    board.rows = sortRows(board.rows);
    return this.commit();
  }

  clearSlotBoard(boardId) {
    const fallback = this.state.leaderboards.find((board) => board.id !== boardId)?.id || null;
    for (const slotId of SLOT_IDS) {
      if (this.state.slots[slotId].leaderboardId === boardId) {
        this.state.slots[slotId].leaderboardId = fallback;
      }
    }
  }

  async archiveLeaderboard(boardId) {
    const index = this.state.leaderboards.findIndex((board) => board.id === boardId);
    if (index === -1) throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    const [board] = this.state.leaderboards.splice(index, 1);
    board.inRotation = false;
    board.archivedAt = Date.now();
    this.state.archivedLeaderboards.push(board);
    this.clearSlotBoard(boardId);
    this.bumpRotationClock();
    return this.commit();
  }

  async restoreLeaderboard(boardId) {
    const index = this.state.archivedLeaderboards.findIndex((board) => board.id === boardId);
    if (index === -1) throw Object.assign(new Error("Unknown archived leaderboard"), { status: 404 });
    const [board] = this.state.archivedLeaderboards.splice(index, 1);
    if (!isMachineBoard(board)) {
      this.state.archivedLeaderboards.splice(index, 0, board);
      throw Object.assign(new Error("Only pinball machine boards can come back"), { status: 400 });
    }
    board.archivedAt = null;
    board.inRotation = true;
    this.state.leaderboards.push(board);
    this.bumpRotationClock();
    return this.commit();
  }

  async deleteArchivedLeaderboard(boardId) {
    const index = this.state.archivedLeaderboards.findIndex((board) => board.id === boardId);
    if (index === -1) throw Object.assign(new Error("Unknown archived leaderboard"), { status: 404 });
    this.state.archivedLeaderboards.splice(index, 1);
    return this.commit();
  }

  allowScore(ip, now = Date.now()) {
    const key = String(ip || "unknown");
    const windowMs = 10 * 60 * 1000;
    const recent = (this.scoreHits.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (recent.length >= 6) {
      this.scoreHits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.scoreHits.set(key, recent);
    return true;
  }

  async submitScore({ boardId, name, score, proofFile, ip, now } = {}) {
    if (!this.allowScore(ip, now)) {
      throw Object.assign(new Error("Too many scores from this phone. Wait a few minutes."), { status: 429 });
    }
    const board = this.findBoard(boardId);
    if (!board) throw Object.assign(new Error("Pick a machine"), { status: 404 });
    const cleanName = String(name || "").trim().slice(0, 40);
    if (!cleanName) throw Object.assign(new Error("Enter a name"), { status: 400 });
    const cleaned = String(score ?? "").replace(/[,_\s]/g, "");
    const parsed = parseScore(score);
    if (!/^\d+$/.test(cleaned) || parsed > 999999999) {
      throw Object.assign(new Error("Enter a score"), { status: 400 });
    }
    const submission = normalizeSubmission({
      id: id(),
      boardId,
      name: cleanName,
      score: parsed,
      proofFile: proofFile || null,
      status: "pending",
      createdAt: now || Date.now(),
    });
    this.state.scoreSubmissions.push(submission);
    if (this.state.scoreSubmissions.length > 300) {
      this.state.scoreSubmissions = this.state.scoreSubmissions.slice(-300);
    }
    await this.commit();
    return submission;
  }

  async reviewScore(submissionId, status) {
    const item = this.state.scoreSubmissions.find((row) => row.id === submissionId);
    if (!item) throw Object.assign(new Error("Unknown submission"), { status: 404 });
    if (item.status !== "pending") {
      throw Object.assign(new Error("That score was already reviewed"), { status: 400 });
    }
    if (status !== "approved" && status !== "rejected") {
      throw Object.assign(new Error("Status must be approved or rejected"), { status: 400 });
    }
    item.status = status;
    if (status === "approved") {
      const board = this.findBoard(item.boardId);
      if (!board) throw Object.assign(new Error("That machine is no longer on a board"), { status: 404 });
      const key = playerKey(item.name);
      const existing = board.rows.find((row) => playerKey(row.name) === key);
      if (existing) {
        if (item.score > existing.score) existing.score = item.score;
        if (item.proofFile) existing.proofFile = item.proofFile;
        existing.createdAt = item.createdAt || Date.now();
      } else {
        board.rows.push(normalizeRow({
          name: item.name,
          score: item.score,
          proofFile: item.proofFile,
          createdAt: item.createdAt,
        }));
      }
      board.rows = sortRows(board.rows);
    }
    return this.commit();
  }
}

module.exports = {
  Store,
  replaceFile,
  removeStaleTemp,
  clearReadOnly,
  LOCKED_RENAME,
  RENAME_BACKOFF_MS,
  PERSIST_RETRY_MS,
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
