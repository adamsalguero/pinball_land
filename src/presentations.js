const crypto = require("crypto");
const fs = require("fs/promises");
const { clampIdle } = require("./config");

const SOURCES = ["webrtc", "airplay", "url", "file"];
const FAILURE_LIMIT = 8;
const FAILURE_WINDOW_MS = 60 * 1000;

function normalizeHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.toString();
}

class Presentations {
  constructor({ idleMinutes = 10, now = () => Date.now(), randomInt = (min, max) => crypto.randomInt(min, max) } = {}) {
    this.idleMinutes = clampIdle(idleMinutes);
    this.now = now;
    this.randomInt = randomInt;
    this.sessions = new Map();
    this.byId = new Map();
    this.byCode = new Map();
    this.failures = new Map();
  }

  setIdleMinutes(value) {
    this.idleMinutes = clampIdle(value);
  }

  makeCode() {
    for (let i = 0; i < 30; i += 1) {
      const code = String(this.randomInt(0, 10000)).padStart(4, "0");
      if (!this.byCode.has(code)) return code;
    }
    throw Object.assign(new Error("Could not assign a share code"), { status: 500 });
  }

  get(slot) {
    return this.sessions.get(String(slot)) || null;
  }

  getById(id) {
    return this.byId.get(id) || null;
  }

  authorizeSharer(presentationId, token) {
    const session = this.byId.get(presentationId);
    if (!session || session.source !== "webrtc") return null;
    if (!token || token !== session.token) return null;
    return session;
  }

  async start({ slot, source, url = null, file = null, idleMinutes, helper = null }) {
    const slotId = String(slot);
    if (!["1", "2", "3"].includes(slotId)) {
      throw Object.assign(new Error("Unknown display"), { status: 404 });
    }
    if (!SOURCES.includes(source)) {
      throw Object.assign(new Error("Unknown presentation source"), { status: 400 });
    }
    const httpUrl = source === "url" ? normalizeHttpUrl(url) : null;
    if (source === "url" && !httpUrl) {
      throw Object.assign(new Error("Enter a web address starting with http:// or https://"), { status: 400 });
    }
    if (source === "file" && !file?.fileUrl) {
      throw Object.assign(new Error("Upload a PDF or an image"), { status: 400 });
    }
    await this.end(slotId);
    const session = {
      id: crypto.randomUUID(),
      slot: slotId,
      source,
      code: source === "webrtc" ? this.makeCode() : null,
      token: crypto.randomBytes(24).toString("hex"),
      status: source === "url" || source === "file" ? "live" : "waiting",
      url: httpUrl,
      fileName: file?.fileName || null,
      fileUrl: file?.fileUrl || null,
      fileKind: file?.fileKind || null,
      filePath: file?.filePath || null,
      idleMinutes: clampIdle(idleMinutes ?? this.idleMinutes),
      startedAt: this.now(),
      lastActivityAt: this.now(),
      helper: helper || null,
    };
    this.sessions.set(slotId, session);
    this.byId.set(session.id, session);
    if (session.code) this.byCode.set(session.code, session);
    return session;
  }

  async end(slot) {
    const session = this.sessions.get(String(slot));
    if (!session) return null;
    this.sessions.delete(session.slot);
    this.byId.delete(session.id);
    if (session.code) this.byCode.delete(session.code);
    if (session.filePath) {
      await fs.unlink(session.filePath).catch(() => {});
    }
    return session;
  }

  async endById(presentationId) {
    const session = this.byId.get(presentationId);
    if (!session) return null;
    return this.end(session.slot);
  }

  async endExpired(now = this.now()) {
    const ended = [];
    for (const session of this.sessions.values()) {
      const idleMs = session.idleMinutes * 60 * 1000;
      if (now - session.lastActivityAt >= idleMs) ended.push(session);
    }
    for (const session of ended) {
      await this.end(session.slot);
    }
    return ended;
  }

  touch(presentationId, now = this.now()) {
    const session = this.byId.get(presentationId);
    if (!session) return null;
    session.lastActivityAt = now;
    return session;
  }

  touchSlot(slot, now = this.now()) {
    const session = this.sessions.get(String(slot));
    if (!session) return null;
    session.lastActivityAt = now;
    return session;
  }

  markLive(presentationId, now = this.now()) {
    const session = this.byId.get(presentationId);
    if (!session) return null;
    session.status = "live";
    session.lastActivityAt = now;
    return session;
  }

  setHelper(slot, helper) {
    const session = this.sessions.get(String(slot));
    if (!session) return null;
    session.helper = helper;
    return session;
  }

  tooMany(ip, now) {
    const bucket = this.failures.get(ip);
    return Boolean(bucket && now <= bucket.resetAt && bucket.count >= FAILURE_LIMIT);
  }

  noteFailure(ip, now) {
    const bucket = this.failures.get(ip);
    if (!bucket || now > bucket.resetAt) {
      this.failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
      return 1;
    }
    bucket.count += 1;
    return bucket.count;
  }

  join({ code, ip = "unknown", now = this.now() }) {
    if (this.tooMany(ip, now)) {
      return {
        ok: false,
        status: 429,
        error: "Too many tries. Wait a minute and read the code on the screen again.",
      };
    }
    const normalized = String(code || "").replace(/\D/g, "").slice(0, 4);
    const session = normalized.length === 4 ? this.byCode.get(normalized) : null;
    if (!session || session.source !== "webrtc") {
      this.noteFailure(ip, now);
      return {
        ok: false,
        status: 401,
        error: "That code is not active. Read the 4-digit code on the screen.",
      };
    }
    this.failures.delete(ip);
    return {
      ok: true,
      status: 200,
      presentationId: session.id,
      slot: session.slot,
      token: session.token,
    };
  }

  toPublic(session) {
    if (!session) return null;
    return {
      id: session.id,
      slot: session.slot,
      source: session.source,
      code: session.code,
      status: session.status,
      url: session.url,
      fileName: session.fileName,
      fileUrl: session.fileUrl,
      fileKind: session.fileKind,
      idleMinutes: session.idleMinutes,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      helper: session.helper
        ? {
            ok: Boolean(session.helper.ok),
            error: session.helper.error || null,
            pid: session.helper.pid || null,
          }
        : null,
    };
  }

  publicState() {
    const out = {};
    for (const [slot, session] of this.sessions) {
      out[slot] = this.toPublic(session);
    }
    return out;
  }
}

module.exports = {
  Presentations,
  SOURCES,
  normalizeHttpUrl,
  FAILURE_LIMIT,
};
