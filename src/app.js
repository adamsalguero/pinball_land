const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { resolveLogos, resolvePhotos, LOGO_KEYS, PHOTO_KEYS } = require("./logos");
const { AMENITIES } = require("./amenities");
const { buildPlaylist } = require("./playlist");
const { createOpdb, manufacturerName, manufactureYear, safeId } = require("./opdb");

const COOKIE_NAME = "pl_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function artUrlFor(board) {
  if (!board?.artFile) return null;
  return `/media/machines/${board.id}/art`;
}

function publicLeaderboards(leaderboards) {
  return (leaderboards || []).map((board) => ({
    ...board,
    artUrl: artUrlFor(board),
    artFile: undefined,
  }));
}

function createApp({
  store,
  pin,
  publicDir,
  logosDir,
  photosDir,
  opdbApiKey = "",
  cacheDir,
  fetchImpl,
}) {
  const app = express();
  const sessions = new Set();
  const opdb = createOpdb({
    apiKey: opdbApiKey,
    cacheDir,
    fetchImpl,
  });

  app.disable("x-powered-by");
  app.use(express.json({ limit: "200kb" }));

  function urlsFor(resolved) {
    const urls = {};
    for (const [key, value] of Object.entries(resolved)) {
      urls[key] = value.url;
    }
    return urls;
  }

  function payload() {
    const state = store.getState();
    return {
      state: {
        ...state,
        leaderboards: publicLeaderboards(state.leaderboards),
      },
      logos: urlsFor(resolveLogos(logosDir)),
      photos: urlsFor(resolvePhotos(photosDir)),
      amenities: AMENITIES,
      playlist: buildPlaylist(state),
      opdb: { configured: opdb.configured },
    };
  }

  function isAuthed(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (sessions.has(cookies[COOKIE_NAME])) {
      return true;
    }
    const headerPin = req.get("x-pin");
    return Boolean(headerPin && headerPin === pin);
  }

  function requirePin(req, res, next) {
    if (isAuthed(req)) {
      return next();
    }
    sendJson(res, 401, { error: "PIN required" });
  }

  app.get("/api/health", (_req, res) => {
    sendJson(res, 200, { ok: true });
  });

  app.get("/api/state", (_req, res) => {
    sendJson(res, 200, payload());
  });

  app.get("/api/auth", (req, res) => {
    sendJson(res, 200, { ok: isAuthed(req) });
  });

  app.post("/api/login", (req, res) => {
    const submitted = String(req.body?.pin || "");
    if (submitted !== pin) {
      return sendJson(res, 401, { error: "Wrong PIN" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    sessions.add(token);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_MS,
    });
    sendJson(res, 200, { ok: true });
  });

  app.post("/api/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    sessions.delete(cookies[COOKIE_NAME]);
    res.clearCookie(COOKIE_NAME, { path: "/" });
    sendJson(res, 200, { ok: true });
  });

  app.put("/api/slots/:id", requirePin, async (req, res, next) => {
    try {
      await store.setSlot(req.params.id, {
        content: req.body?.content,
        leaderboardId: req.body?.leaderboardId,
      });
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/off", requirePin, async (_req, res, next) => {
    try {
      await store.blackAll();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/resume", requirePin, async (_req, res, next) => {
    try {
      await store.resumeWall();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/theme", requirePin, async (req, res, next) => {
    try {
      await store.setTheme(req.body?.theme);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/rotation", requirePin, async (req, res, next) => {
    try {
      await store.setRotation({
        enabled: req.body?.enabled,
        intervalSec: req.body?.intervalSec,
        items: req.body?.items,
      });
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/opdb/search", requirePin, async (req, res, next) => {
    try {
      const q = String(req.query.q || "");
      const results = await opdb.search(q);
      sendJson(res, 200, { configured: opdb.configured, results });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/machines", requirePin, async (req, res, next) => {
    try {
      const name = String(req.body?.name || "").trim();
      const opdbId = safeId(req.body?.opdbId || "");
      if (!name && !opdbId) {
        return sendJson(res, 400, { error: "Enter a machine name or pick a search result" });
      }
      let extra = {
        kind: "machine",
        inRotation: true,
        opdbId: opdbId || null,
      };
      if (opdbId && opdb.configured) {
        try {
          const cached = await opdb.cacheMachine(opdbId);
          extra = {
            ...extra,
            name: name || cached.machine?.name || opdbId,
            manufacturer: manufacturerName(cached.machine),
            year: manufactureYear(cached.machine),
            artFile: cached.artFile,
            videoUrl: cached.videoUrl,
          };
        } catch {
          extra.name = name || opdbId;
        }
      } else {
        extra.name = name || opdbId;
      }
      await store.createLeaderboard(extra.name, extra);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/leaderboards", requirePin, async (req, res, next) => {
    try {
      await store.createLeaderboard(req.body?.name, { kind: "event", inRotation: true });
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/leaderboards/:id", requirePin, async (req, res, next) => {
    try {
      await store.updateLeaderboard(req.params.id, {
        name: req.body?.name,
        inRotation: req.body?.inRotation,
      });
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/leaderboards/:id", requirePin, async (req, res, next) => {
    try {
      await store.deleteLeaderboard(req.params.id);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/leaderboards/:id/clear", requirePin, async (req, res, next) => {
    try {
      await store.clearLeaderboard(req.params.id);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/leaderboards/:id/rows", requirePin, async (req, res, next) => {
    try {
      await store.addRow(req.params.id, {
        name: req.body?.name,
        score: req.body?.score,
      });
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/leaderboards/:id/rows/:rowId", requirePin, async (req, res, next) => {
    try {
      await store.updateRow(req.params.id, req.params.rowId, {
        name: req.body?.name,
        score: req.body?.score,
      });
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/leaderboards/:id/rows/:rowId", requirePin, async (req, res, next) => {
    try {
      await store.deleteRow(req.params.id, req.params.rowId);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/leaderboards/:id/rows/:rowId/move", requirePin, async (req, res, next) => {
    try {
      await store.moveRow(req.params.id, req.params.rowId, req.body?.direction);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  function sendMedia(res, resolved, key, kind) {
    if (!resolved[key]) {
      return res.status(404).send(`Unknown ${kind}`);
    }
    const filePath = resolved[key].filePath;
    if (!filePath) {
      return res.status(404).send(`${kind} file not found`);
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(filePath);
  }

  app.get("/logos/:key", (req, res) => {
    if (!LOGO_KEYS.includes(req.params.key)) {
      return res.status(404).send("Unknown logo");
    }
    sendMedia(res, resolveLogos(logosDir), req.params.key, "Logo");
  });

  app.get("/photos/:key", (req, res) => {
    if (!PHOTO_KEYS.includes(req.params.key)) {
      return res.status(404).send("Unknown photo");
    }
    sendMedia(res, resolvePhotos(photosDir), req.params.key, "Photo");
  });

  app.get("/media/machines/:id/art", (req, res) => {
    const board = store.findBoard(req.params.id);
    if (!board?.artFile || !cacheDir) {
      return res.status(404).send("No machine art");
    }
    const filePath = path.join(cacheDir, board.artFile);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(cacheDir))) {
      return res.status(404).send("No machine art");
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).send("No machine art");
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(resolved);
  });

  app.get("/display/:slot", (req, res) => {
    if (!["1", "2", "3"].includes(req.params.slot)) {
      return res.status(404).send("Unknown display. Use /display/1, /display/2, or /display/3.");
    }
    res.sendFile(path.join(publicDir, "display.html"));
  });

  app.get(["/", "/control"], (_req, res) => {
    res.sendFile(path.join(publicDir, "control.html"));
  });

  app.use(express.static(publicDir, { fallthrough: true }));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) {
      console.error(err);
    }
    sendJson(res, status, { error: err.message || "Server error" });
  });

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ server, path: "/ws" });

    function broadcast() {
      const message = JSON.stringify({ type: "state", ...payload() });
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          client.send(message);
        }
      }
    }

    store.onChange(() => broadcast());

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "state", ...payload() }));
    });

    return wss;
  }

  return { app, attachWebSocket, sessions };
}

module.exports = { createApp };
