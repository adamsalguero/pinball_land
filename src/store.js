const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const SLOT_IDS = ["1", "2", "3"];
const CONTENTS = ["pinnacle", "pinball-land", "leaderboard", "off"];

function id() {
  return crypto.randomUUID();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  const halloweenId = id();
  return {
    slots: {
      1: { content: "pinnacle", leaderboardId: halloweenId },
      2: { content: "pinball-land", leaderboardId: halloweenId },
      3: { content: "leaderboard", leaderboardId: halloweenId },
    },
    leaderboards: [
      {
        id: halloweenId,
        name: "Halloween party",
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
    return { id: id(), name: "Untitled event", rows: [] };
  }
  return {
    id: typeof board.id === "string" && board.id ? board.id : id(),
    name: String(board.name || "Untitled event").trim() || "Untitled event",
    rows: Array.isArray(board.rows) ? board.rows.map(normalizeRow) : [],
  };
}

function normalizeSlot(slot, fallbackLeaderboardId) {
  const content = CONTENTS.includes(slot?.content) ? slot.content : "off";
  const leaderboardId =
    typeof slot?.leaderboardId === "string" && slot.leaderboardId
      ? slot.leaderboardId
      : fallbackLeaderboardId;
  return { content, leaderboardId };
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
  return { slots, leaderboards };
}

class Store {
  constructor(filePath, state) {
    this.filePath = filePath;
    this.state = normalizeState(state);
    this.listeners = new Set();
  }

  static async load(filePath) {
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
    await fs.rename(tmp, this.filePath);
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

  async setSlot(slotId, patch) {
    if (!SLOT_IDS.includes(String(slotId))) {
      throw Object.assign(new Error("Unknown slot"), { status: 404 });
    }
    const slot = this.state.slots[slotId];
    if (patch.content !== undefined) {
      if (!CONTENTS.includes(patch.content)) {
        throw Object.assign(new Error("Unknown slot content"), { status: 400 });
      }
      slot.content = patch.content;
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
    for (const slotId of SLOT_IDS) {
      this.state.slots[slotId].content = "off";
    }
    return this.commit();
  }

  async createLeaderboard(name) {
    const board = normalizeLeaderboard({
      id: id(),
      name: name || "New event",
      rows: [],
    });
    this.state.leaderboards.push(board);
    return this.commit();
  }

  async renameLeaderboard(boardId, name) {
    const board = this.findBoard(boardId);
    if (!board) {
      throw Object.assign(new Error("Unknown leaderboard"), { status: 404 });
    }
    board.name = String(name || "").trim() || board.name;
    return this.commit();
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
  SLOT_IDS,
  CONTENTS,
  defaultState,
  normalizeState,
};
