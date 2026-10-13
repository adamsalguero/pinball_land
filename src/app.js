const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const { resolveLogos, resolvePhotos, LOGO_KEYS, PHOTO_KEYS } = require("./logos");
const { AMENITIES } = require("./amenities");
const { buildPlaylist } = require("./playlist");
const { createOpdb, manufacturerName, manufactureYear, safeId } = require("./opdb");
const { createConfigStore } = require("./config");
const { AirplayController } = require("./airplay");
const { getLanIPv4s, lanRequired, loopbackRequired } = require("./lan");
const { Presentations } = require("./presentations");
const { DISPLAY_CONTENTS, layoutForDisplays, mapDisplaysToSlots } = require("./displays");

const UPLOAD_TYPES = {
  "image/jpeg": { ext: ".jpg", kind: "image" },
  "image/png": { ext: ".png", kind: "image" },
  "image/webp": { ext: ".webp", kind: "image" },
  "image/gif": { ext: ".gif", kind: "image" },
  "application/pdf": { ext: ".pdf", kind: "pdf" },
};

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
  configStore = null,
  uploadsDir = null,
  isHttpsReady = () => false,
  airplay = null,
  now,
}) {
  const app = express();
  const sessions = new Set();
  const opdb = createOpdb({
    apiKey: opdbApiKey,
    cacheDir,
    fetchImpl,
  });
  const localStore = configStore || createConfigStore(path.join(os.tmpdir(), `pinball-land-${crypto.randomUUID()}`, "config.json"));
  const uploadRoot = uploadsDir || path.join(os.tmpdir(), `pinball-land-uploads-${crypto.randomUUID()}`);
  const presentations = new Presentations({
    idleMinutes: localStore.get().presentation.idleMinutes,
    now,
  });
  let restartToken = 0;
  let monitors = [];
  const clients = new Set();
  let broadcast = () => {};
  const airplayController = airplay || new AirplayController({
    spawnImpl: spawn,
    root: path.join(__dirname, ".."),
    getAirplayConfig: () => localStore.get().airplay,
    onExit(slot, message) {
      const session = presentations.get(slot);
      if (!session || session.source !== "airplay") return;
      presentations.setHelper(slot, { ok: false, error: message, pid: null });
      broadcast();
    },
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

  function currentConfig() {
    return localStore.get();
  }

  function shareInfo(config) {
    const httpsPort = config.httpsPort;
    const secure = Boolean(isHttpsReady()) && Boolean(httpsPort) && httpsPort !== config.port;
    return {
      secure,
      port: secure ? httpsPort : config.port,
      hosts: getLanIPv4s(),
      path: "/present",
    };
  }

  function rememberMonitors(list) {
    monitors = Array.isArray(list)
      ? list.filter((item) => item && item.bounds).map((item) => ({
          id: item.id,
          bounds: {
            x: Number(item.bounds.x) || 0,
            y: Number(item.bounds.y) || 0,
            width: Number(item.bounds.width) || 0,
            height: Number(item.bounds.height) || 0,
          },
        }))
      : [];
  }

  function payload() {
    const state = store.getState();
    const config = currentConfig();
    const displays = config.displays;
    const mapped = mapDisplaysToSlots(monitors, displays);
    const air = airplayController.ready();
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
      displays,
      layout: layoutForDisplays(displays),
      presentations: presentations.publicState(),
      presentation: { idleMinutes: config.presentation.idleMinutes },
      share: shareInfo(config),
      airplay: {
        ready: Boolean(air.ok),
        serverName: config.airplay.windowTitle,
      },
      kiosk: {
        restartToken,
        monitors: mapped.arranged.map((display) => ({
          id: display.id,
          bounds: display.bounds,
        })),
        planned: mapped.windows,
        skipped: mapped.skipped,
      },
    };
  }

  function sendAll(message) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  broadcast = () => {
    sendAll({ type: "state", ...payload() });
  };

  function assertOpen(slot) {
    if (!["1", "2", "3"].includes(String(slot))) {
      throw Object.assign(new Error("Unknown display"), { status: 404 });
    }
    const layout = layoutForDisplays(currentConfig().displays)[String(slot)];
    if (!layout?.enabled) {
      throw Object.assign(new Error("That display is turned off. Enable it under Displays first."), { status: 400 });
    }
  }

  async function endAirplayOnOtherSlots(slot) {
    for (const other of ["1", "2", "3"]) {
      if (other === String(slot)) continue;
      const existing = presentations.get(other);
      if (existing?.source === "airplay") {
        airplayController.stop();
        await presentations.end(other);
      }
    }
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
      const displays = currentConfig().displays;
      const screens = {};
      let dirty = false;
      for (const slot of ["1", "2", "3"]) {
        if (displays.screens[slot].leaderboardId === req.params.id) {
          screens[slot] = { leaderboardId: null };
          dirty = true;
        }
      }
      if (dirty) await localStore.update({ displays: { screens } });
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

  app.put("/api/displays", requirePin, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.screens && typeof body.screens === "object") {
        for (const slot of ["1", "2", "3"]) {
          const screen = body.screens[slot];
          if (!screen) continue;
          if (screen.content !== undefined && !DISPLAY_CONTENTS.includes(screen.content)) {
            return sendJson(res, 400, { error: "Unknown display content" });
          }
          if (screen.leaderboardId && !store.findBoard(screen.leaderboardId)) {
            return sendJson(res, 400, { error: "Unknown leaderboard" });
          }
        }
      }
      const displays = {};
      if (body.count !== undefined) displays.count = body.count;
      if (body.mirror !== undefined) displays.mirror = body.mirror;
      if (body.order !== undefined) displays.order = body.order;
      if (body.screens !== undefined) displays.screens = body.screens;
      if (Object.keys(displays).length) await localStore.update({ displays });
      if (body.idleMinutes !== undefined) {
        await localStore.update({ presentation: { idleMinutes: body.idleMinutes } });
        presentations.setIdleMinutes(currentConfig().presentation.idleMinutes);
      }
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/presentation", requirePin, async (req, res, next) => {
    try {
      await localStore.update({ presentation: { idleMinutes: req.body?.idleMinutes } });
      presentations.setIdleMinutes(currentConfig().presentation.idleMinutes);
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/kiosk/restart", requirePin, (req, res) => {
    restartToken += 1;
    console.log("Kiosk window restart requested.");
    broadcast();
    sendJson(res, 200, payload());
  });

  app.post("/api/kiosk/monitors", loopbackRequired, (req, res) => {
    rememberMonitors(req.body?.displays);
    sendAll({ type: "kiosk", kiosk: payload().kiosk });
    sendJson(res, 200, { ok: true, count: monitors.length });
  });

  app.post("/api/present/join", lanRequired, (req, res) => {
    const result = presentations.join({
      code: req.body?.code,
      ip: req.socket?.remoteAddress || "unknown",
    });
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    sendJson(res, 200, {
      ok: true,
      presentationId: result.presentationId,
      slot: result.slot,
      token: result.token,
    });
  });

  app.post("/api/present/:slot/start", lanRequired, requirePin, async (req, res, next) => {
    try {
      const slot = String(req.params.slot);
      assertOpen(slot);
      const source = String(req.body?.source || "");
      if (source === "file") {
        return sendJson(res, 400, { error: "Upload the PDF or image to show it on this screen." });
      }
      if (source === "airplay") await endAirplayOnOtherSlots(slot);
      const helper = source === "airplay"
        ? airplayController.start({ slot, bounds: boundsForSlot(slot) })
        : null;
      const session = await presentations.start({
        slot,
        source,
        url: req.body?.url,
        idleMinutes: currentConfig().presentation.idleMinutes,
        helper,
      });
      if (session.code) {
        console.log(`Presentation on display ${slot}: ${source}, code ${session.code}`);
      } else {
        console.log(`Presentation on display ${slot}: ${source}`);
      }
      if (helper && !helper.ok) {
        console.warn(`AirPlay helper: ${helper.error}`);
      }
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/present/:slot/end", lanRequired, requirePin, async (req, res, next) => {
    try {
      const slot = String(req.params.slot);
      const existing = presentations.get(slot);
      if (existing?.source === "airplay") airplayController.stop();
      await presentations.end(slot);
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/present/:slot/touch", lanRequired, requirePin, (req, res) => {
    const session = presentations.touchSlot(req.params.slot);
    if (!session) return sendJson(res, 404, { error: "No presentation on that display" });
    broadcast();
    sendJson(res, 200, payload());
  });

  app.post(
    "/api/present/:slot/file",
    lanRequired,
    requirePin,
    express.raw({ limit: "20mb", type: () => true }),
    async (req, res, next) => {
      try {
        const slot = String(req.params.slot);
        assertOpen(slot);
        const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const spec = UPLOAD_TYPES[mime];
        if (!spec) return sendJson(res, 400, { error: "Upload a PNG, JPEG, WEBP, GIF, or PDF." });
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!body.length) return sendJson(res, 400, { error: "That file is empty." });
        await fs.promises.mkdir(uploadRoot, { recursive: true });
        const filename = `${crypto.randomUUID()}${spec.ext}`;
        const filePath = path.join(uploadRoot, filename);
        await fs.promises.writeFile(filePath, body);
        const original = path.basename(String(req.get("x-filename") || "upload")).replace(/[^\w.\- ]+/g, "").slice(0, 80);
        await presentations.start({
          slot,
          source: "file",
          idleMinutes: currentConfig().presentation.idleMinutes,
          file: {
            fileName: original || filename,
            fileUrl: `/media/uploads/${filename}`,
            fileKind: spec.kind,
            filePath,
          },
        });
        console.log(`Presentation on display ${slot}: file`);
        broadcast();
        sendJson(res, 200, payload());
      } catch (err) {
        next(err);
      }
    }
  );

  function boundsForSlot(slot) {
    const mapped = mapDisplaysToSlots(monitors, currentConfig().displays);
    return mapped.windows.find((item) => String(item.slot) === String(slot))?.bounds || null;
  }

  app.get("/media/uploads/:file", (req, res) => {
    const name = String(req.params.file || "");
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif|pdf)$/i.test(name)) {
      return res.status(404).send("Not found");
    }
    const filePath = path.resolve(uploadRoot, name);
    const root = path.resolve(uploadRoot);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      return res.status(404).send("Not found");
    }
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(filePath);
  });

  app.get("/present", lanRequired, (_req, res) => {
    res.sendFile(path.join(publicDir, "present.html"));
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

  function hasViewer(presentationId) {
    for (const client of clients) {
      if (client.presentRole?.presentationId === presentationId && client.presentRole.role === "viewer") {
        return true;
      }
    }
    return false;
  }

  function notifySharers(presentationId) {
    const message = JSON.stringify({ type: "present-viewer-ready", presentationId });
    for (const client of clients) {
      if (client.readyState !== 1) continue;
      if (client.presentRole?.presentationId === presentationId && client.presentRole.role === "sharer") {
        client.send(message);
      }
    }
  }

  function relay(from, presentationId, signalPayload) {
    if (!signalPayload || typeof signalPayload !== "object") return;
    const message = JSON.stringify({
      type: "present-signal",
      presentationId,
      from: from.presentRole?.role || null,
      payload: signalPayload,
    });
    for (const client of clients) {
      if (client === from || client.readyState !== 1) continue;
      if (client.presentRole?.presentationId !== presentationId) continue;
      if (client.presentRole?.role === from.presentRole?.role) continue;
      client.send(message);
    }
  }

  async function handleClientMessage(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "present-hello") {
      const presentationId = String(message.presentationId || "");
      const role = message.role === "sharer" || message.role === "viewer" ? message.role : null;
      if (!role) return;
      const session = presentations.getById(presentationId);
      if (!session) {
        socket.send(JSON.stringify({ type: "present-error", error: "That presentation has ended." }));
        return;
      }
      if (role === "sharer" && !presentations.authorizeSharer(presentationId, message.token)) {
        socket.send(JSON.stringify({ type: "present-error", error: "Share session was rejected." }));
        return;
      }
      socket.presentRole = { presentationId, role };
      socket.send(JSON.stringify({ type: "present-hello-ok", presentationId, role }));
      if (role === "viewer") notifySharers(presentationId);
      else if (hasViewer(presentationId)) {
        socket.send(JSON.stringify({ type: "present-viewer-ready", presentationId }));
      }
      return;
    }

    if (message.type === "present-signal") {
      const presentationId = socket.presentRole?.presentationId;
      if (!presentationId || presentationId !== message.presentationId) return;
      if (socket.presentRole.role === "sharer" && !presentations.authorizeSharer(presentationId, message.token)) return;
      if (socket.presentRole.role === "sharer") presentations.touch(presentationId);
      relay(socket, presentationId, message.payload);
      return;
    }

    if (message.type === "present-heartbeat") {
      const presentationId = socket.presentRole?.presentationId;
      if (socket.presentRole?.role !== "sharer") return;
      if (!presentations.authorizeSharer(presentationId, message.token)) return;
      presentations.touch(presentationId);
      return;
    }

    if (message.type === "present-live") {
      if (socket.presentRole?.role !== "viewer") return;
      if (presentations.markLive(socket.presentRole.presentationId)) broadcast();
      return;
    }

    if (message.type === "present-ended") {
      if (socket.presentRole?.role !== "sharer") return;
      const presentationId = socket.presentRole.presentationId;
      if (!presentations.authorizeSharer(presentationId, message.token)) return;
      const session = await presentations.endById(presentationId);
      if (session?.source === "airplay") airplayController.stop();
      broadcast();
    }
  }

  store.onChange(() => broadcast());

  const sweepTimer = setInterval(async () => {
    try {
      const ended = await presentations.endExpired();
      if (!ended.length) return;
      if (ended.some((session) => session.source === "airplay")) airplayController.stop();
      console.log(`Ended idle presentation on display ${ended.map((session) => session.slot).join(", ")}.`);
      broadcast();
    } catch (err) {
      console.error(err);
    }
  }, 15000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.send(JSON.stringify({ type: "state", ...payload() }));
      socket.on("message", (raw) => {
        handleClientMessage(socket, raw).catch((err) => console.error(err));
      });
    });
    return wss;
  }

  return { app, attachWebSocket, sessions, presentations };
}

module.exports = { createApp };
