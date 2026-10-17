const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const { resolveLogos, resolvePhotos, LOGO_KEYS, PHOTO_KEYS } = require("./logos");
const { AMENITIES } = require("./amenities");
const { buildPlaylist, planRotation } = require("./playlist");
const { createOpdb, manufacturerName, manufactureYear, safeId } = require("./opdb");
const { createConfigStore } = require("./config");
const { AirplayController, AIRPLAY_TARGETS } = require("./airplay");
const { getLanIPv4s, isLanAddress, forwardedAddress, lanRequired, loopbackRequired } = require("./lan");
const { Presentations } = require("./presentations");
const { canonicalDisplayContent, layoutForDisplays, mapDisplaysToSlots } = require("./displays");
const { PlugService, createTplinkClient } = require("./plugs");
const { MediaLibrary, MAX_BYTES, extensionFor, normalizeFolder } = require("./media");
const { DeviceStore, COOKIE_NAME: DEVICE_COOKIE, DEVICE_MAX_AGE_MS, pinIsValid, DEFAULT_PIN } = require("./devices");
const { GuestAlbum } = require("./photos");
const { loadCatalog, starterFile, starterCards } = require("./catalog");
const { embedSrc, parseYoutubeInput } = require("./youtube");
const { isInside, defaultDataDir, dataLayout } = require("./paths");
const { launchDetachedUpdate, launchRegisterTasks, readGitCommit, readUpdateStatusSync } = require("./self-update");
const pkg = require("../package.json");

const UPLOAD_TYPES = {
  "image/jpeg": { ext: ".jpg", kind: "image" },
  "image/png": { ext: ".png", kind: "image" },
  "image/webp": { ext: ".webp", kind: "image" },
  "image/gif": { ext: ".gif", kind: "image" },
  "application/pdf": { ext: ".pdf", kind: "pdf" },
};

const COOKIE_NAME = DEVICE_COOKIE;
const SESSION_MAX_AGE_MS = DEVICE_MAX_AGE_MS;

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

function machineAssetUrl(board, kind) {
  const file = kind === "playfield" ? board?.playfieldFile : kind === "logo" ? board?.logoFile : board?.artFile;
  if (!file) return null;
  return `/media/machines/${encodeURIComponent(board.id)}/${kind === "playfield" ? "playfield" : kind === "logo" ? "logo" : "art"}`;
}

function publicLeaderboards(leaderboards) {
  return (leaderboards || []).map((board) => ({
    ...board,
    artUrl: machineAssetUrl(board, "art"),
    playfieldUrl: machineAssetUrl(board, "playfield"),
    logoUrl: machineAssetUrl(board, "logo"),
    artFile: undefined,
    playfieldFile: undefined,
    logoFile: undefined,
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
  plugs = null,
  mediaDir = null,
  mediaCatalog = null,
  devicesPath = null,
  guestPhotosDir = null,
  catalogPath = null,
  now,
  dataDir = null,
  appRoot = path.join(__dirname, ".."),
}) {
  const app = express();
  const opdb = createOpdb({
    apiKey: opdbApiKey,
    cacheDir,
    fetchImpl,
  });
  const externalConfig = Boolean(configStore);
  const localStore = configStore || createConfigStore(path.join(os.tmpdir(), `pinball-land-${crypto.randomUUID()}`, "config.json"));
  let activePin = pin;
  const uploadRoot = uploadsDir || path.join(os.tmpdir(), `pinball-land-uploads-${crypto.randomUUID()}`);
  const presentations = new Presentations({
    idleMinutes: localStore.get().presentation.idleMinutes,
    now,
  });
  let restartToken = 0;
  let monitors = [];
  const clients = new Set();
  let broadcast = () => {};
  let onAirplaySession = () => {};
  const airplayController = airplay || new AirplayController({
    spawnImpl: spawn,
    root: path.join(__dirname, ".."),
    getAirplayConfig: () => localStore.get().airplay,
    onSession(event, active) {
      onAirplaySession(event, active);
    },
    onExit(slot, message) {
      const session = presentations.get(slot);
      if (!session || session.source !== "airplay") return;
      presentations.setHelper(slot, { ok: false, error: message, pid: null });
      broadcast();
    },
  });
  const mediaRoot = mediaDir || path.join(os.tmpdir(), `pinball-media-${crypto.randomUUID()}`);
  const library = new MediaLibrary({
    root: mediaRoot,
    catalogPath: mediaCatalog || path.join(mediaRoot, "library.json"),
  });
  const plugService = plugs || new PlugService({
    client: process.env.PINBALL_PLUG_MOCK === "1" ? require("./plugs").createMockPlugClient() : createTplinkClient(),
    getConfig: () => localStore.get(),
    updateConfig: (patch) => localStore.update(patch),
  });
  const deviceFile = devicesPath || path.join(path.dirname(uploadRoot), "devices.json");
  const devices = new DeviceStore(deviceFile);
  const album = new GuestAlbum({
    root: guestPhotosDir || path.join(path.dirname(uploadRoot), "guest-photos"),
  });
  const catalogItems = loadCatalog(catalogPath || path.join(__dirname, "..", "media", "catalog.json"));
  let playback = null;
  const updateDataDir = dataDir || defaultDataDir();
  let commitCache = null;
  let statusCache = { at: 0, value: null };

  function updateFields(config) {
    if (commitCache === null) commitCache = readGitCommit(appRoot);
    const nowMs = Date.now();
    if (!statusCache.value || nowMs - statusCache.at > 5000) {
      statusCache = {
        at: nowMs,
        value: readUpdateStatusSync(dataLayout(updateDataDir).logs) || {},
      };
    }
    const status = statusCache.value || {};
    const updates = config.updates || {};
    return {
      enabled: updates.enabled !== false,
      channel: updates.channel === "preview" ? "preview" : "stable",
      intervalMin: updates.intervalMin || 30,
      quietStart: updates.quietStart || "02:00",
      quietEnd: updates.quietEnd || "06:00",
      nightlyAt: updates.nightlyAt || "03:17",
      branch: updates.branch || "main",
      commit: commitCache,
      lastAt: status.at || null,
      lastResult: status.action || null,
      lastDetail: status.detail || "",
    };
  }

  function currentPin() {
    if (externalConfig) return localStore.get().pin;
    return activePin;
  }

  async function changePin(next) {
    if (!pinIsValid(next)) {
      throw Object.assign(new Error("PIN must be 4 to 12 digits"), { status: 400 });
    }
    activePin = String(next);
    await localStore.update({ pin: activePin });
    return activePin;
  }

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
    const layout = layoutForDisplays(displays);
    const playlist = buildPlaylist(state, {
      videos: library.list(),
      allAges: config.media.allAges,
      starters: starterCards(catalogItems, {
        theme: state.theme,
        allAges: config.media.allAges,
        mediaRoot: mediaRoot,
        urlFor: (id) => `/media/starter/${id}`,
        disabledIds: config.media.disabledIds,
      }),
      youtube: config.youtube?.[state.theme] || [],
    });
    const rotationPlan = planRotation(playlist, {
      startedAt: state.rotation.startedAt,
      intervalSec: state.rotation.intervalSec,
      screenCount: displays.count,
      layout,
      now: Date.now(),
    });
    return {
      state: {
        ...state,
        leaderboards: publicLeaderboards(state.leaderboards),
        archivedLeaderboards: publicLeaderboards(state.archivedLeaderboards),
      },
      logos: urlsFor(resolveLogos(logosDir)),
      photos: urlsFor(resolvePhotos(photosDir)),
      amenities: AMENITIES,
      playlist,
      rotationPlan,
      opdb: { configured: opdb.configured },
      displays,
      layout,
      presentations: presentations.publicState(),
      presentation: { idleMinutes: config.presentation.idleMinutes },
      share: shareInfo(config),
      airplay: {
        ready: Boolean(air.ok),
        running: Boolean(airplayController.pid?.()),
        pid: airplayController.pid?.() || null,
        serverName: config.airplay.windowTitle,
        target: config.airplay.target,
        active: Boolean(airplayController.isActive?.()),
        primarySlot: targetSlots(config.airplay.target, displays)[0] || null,
        error: air.ok ? null : air.error || null,
      },
      plugs: plugService.publicState(),
      media: {
        allAges: config.media.allAges,
        disabledIds: config.media.disabledIds || [],
        videos: library.list(),
        catalog: catalogItems.map((item) => ({
          ...item,
          disabled: (config.media.disabledIds || []).includes(item.id),
        })),
      },
      playback: publicPlayback(),
      motion: config.motion,
      serverNow: Date.now(),
      version: pkg.version,
      youtube: config.youtube,
      guest: {
        path: "/app",
        publicUrl: config.photos.publicBaseUrl ? `${config.photos.publicBaseUrl.replace(/\/$/, "")}/app` : null,
        eventName: config.photos.eventName,
        style: config.photos.style,
        span: config.photos.span,
        autoApprove: config.photos.autoApprove,
        photos: album.feed(),
        events: album.events.map((event) => ({ id: event.id, name: event.name, createdAt: event.createdAt })),
      },
      updates: updateFields(config),
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

  function publicPayload(full) {
    return {
      state: {
        ...full.state,
        archivedLeaderboards: undefined,
        scoreSubmissions: undefined,
      },
      logos: full.logos,
      photos: full.photos,
      amenities: full.amenities,
      playlist: full.playlist,
      rotationPlan: full.rotationPlan,
      guest: {
        path: full.guest.path,
        eventName: full.guest.eventName,
        style: full.guest.style,
        photos: full.guest.photos,
        events: full.guest.events,
      },
      serverNow: full.serverNow,
      version: full.version,
      motion: full.motion,
    };
  }

  function stateFor(trusted) {
    const full = payload();
    return trusted ? full : publicPayload(full);
  }

  broadcast = () => {
    for (const client of clients) {
      if (client.readyState !== 1) continue;
      client.send(JSON.stringify({ type: "state", ...stateFor(client.trusted !== false) }));
    }
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

  function enabledSlots() {
    const layout = layoutForDisplays(currentConfig().displays);
    return ["1", "2", "3"].filter((slot) => layout[slot]?.enabled);
  }

  function targetSlots(target, displays) {
    const layout = layoutForDisplays(displays || currentConfig().displays);
    if (target === "all") return ["1", "2", "3"].filter((slot) => layout[slot]?.enabled);
    if (["1", "2", "3"].includes(String(target)) && layout[String(target)]?.enabled) return [String(target)];
    return [];
  }

  function publicPlayback() {
    if (!playback) return null;
    if (playback.kind === "youtube") {
      return {
        kind: "youtube",
        videoId: playback.videoId,
        title: playback.title,
        mode: playback.mode,
        slots: playback.slots,
        startedAt: playback.startedAt,
        embed: embedSrc({ id: playback.videoId, kind: playback.youtubeKind || "video" }),
      };
    }
    const video = library.get(playback.videoId);
    if (!video) return null;
    const pub = library.toPublic(video);
    return {
      kind: "file",
      videoId: video.id,
      title: pub.title,
      url: pub.url,
      mode: playback.mode,
      slots: playback.slots,
      startedAt: playback.startedAt,
      loop: playback.playlist.length < 2 && playback.loop,
      playlist: playback.playlist,
      index: playback.index,
    };
  }

  async function endAirplayPresentations() {
    for (const slot of ["1", "2", "3"]) {
      const existing = presentations.get(slot);
      if (existing?.source === "airplay") await presentations.end(slot);
    }
  }

  async function syncAirplayPresentations() {
    const config = currentConfig();
    const slots = airplayController.isActive?.() ? targetSlots(config.airplay.target, config.displays) : [];
    const primary = slots[0] || null;
    const pid = airplayController.pid?.() || null;
    for (const slot of ["1", "2", "3"]) {
      const existing = presentations.get(slot);
      if (existing?.source === "airplay" && !slots.includes(slot)) await presentations.end(slot);
    }
    for (const slot of slots) {
      const existing = presentations.get(slot);
      const helper = {
        ok: true,
        pid,
        error: null,
        mirror: slot !== primary,
        capture: slot !== primary,
      };
      if (existing?.source === "airplay") {
        presentations.setHelper(slot, helper);
        continue;
      }
      if (existing) continue;
      await presentations.start({
        slot,
        source: "airplay",
        hold: true,
        idleMinutes: config.presentation.idleMinutes,
        helper,
      });
    }
  }

  let airplayChain = Promise.resolve();
  function queueAirplay(work) {
    airplayChain = airplayChain.then(work).catch((err) => console.error(err));
    return airplayChain;
  }

  onAirplaySession = () => {
    queueAirplay(async () => {
      await syncAirplayPresentations();
      broadcast();
    });
  };

  function videoForPlay(id) {
    const video = library.get(id);
    if (!video) throw Object.assign(new Error("Unknown video"), { status: 404 });
    if (currentConfig().media.allAges && video.allAges === false) {
      throw Object.assign(new Error("All-ages is on. Turn it off in Videos, or mark this clip all-ages."), { status: 400 });
    }
    return video;
  }

  function slotsForPlayback(mode, slot) {
    if (mode === "one") {
      const chosen = String(slot || "");
      if (!enabledSlots().includes(chosen)) {
        throw Object.assign(new Error("Pick an enabled screen"), { status: 400 });
      }
      return [chosen];
    }
    if (mode === "sync" || mode === "span") {
      const slots = enabledSlots();
      if (!slots.length) throw Object.assign(new Error("Turn a display on first"), { status: 400 });
      return slots;
    }
    throw Object.assign(new Error("Playback is one screen, sync, or span"), { status: 400 });
  }

  function presentedToken(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[COOKIE_NAME] || req.get("x-device-token") || "";
  }

  function pinMatches(submitted) {
    const given = Buffer.from(String(submitted || ""));
    const expected = Buffer.from(String(currentPin()));
    if (given.length !== expected.length || given.length === 0) return false;
    return crypto.timingSafeEqual(given, expected);
  }

  const loginFailures = new Map();
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_LIMIT = 8;

  function recentFailures(ip) {
    const now = Date.now();
    const hits = (loginFailures.get(ip) || []).filter((stamp) => now - stamp < LOGIN_WINDOW_MS);
    if (hits.length) loginFailures.set(ip, hits);
    else loginFailures.delete(ip);
    return hits;
  }

  function isAuthed(req) {
    if (devices.find(presentedToken(req))) return true;
    return pinMatches(req.get("x-pin"));
  }

  function setDeviceCookie(req, res, token) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: Boolean(req.secure),
      path: "/",
      maxAge: SESSION_MAX_AGE_MS,
    });
  }

  function requirePin(req, res, next) {
    if (!isLanAddress(forwardedAddress(req))) {
      return sendJson(res, 403, { error: "Admin controls stay on the venue network." });
    }
    const device = devices.find(presentedToken(req));
    if (device) {
      if (Date.now() - device.lastSeen > 60 * 1000) {
        devices.touch(device.id);
        devices.save().catch((err) => console.error(err));
      } else {
        devices.touch(device.id);
      }
      return next();
    }
    const ip = forwardedAddress(req);
    if (recentFailures(ip).length >= LOGIN_LIMIT) {
      return sendJson(res, 429, { error: "Too many PIN attempts. Wait 15 minutes." });
    }
    if (!pinMatches(req.get("x-pin"))) {
      if (req.get("x-pin")) {
        const hits = recentFailures(ip);
        hits.push(Date.now());
        loginFailures.set(ip, hits);
      }
      return sendJson(res, 401, { error: "PIN required" });
    }
    loginFailures.delete(ip);
    return next();
  }

  app.get("/api/health", (_req, res) => {
    sendJson(res, 200, { ok: true });
  });

  app.get("/api/state", (req, res) => {
    sendJson(res, 200, stateFor(isLanAddress(forwardedAddress(req))));
  });

  app.get("/api/auth", (req, res) => {
    sendJson(res, 200, { ok: isAuthed(req) });
  });

  app.post("/api/login", lanRequired, async (req, res, next) => {
    try {
      const ip = forwardedAddress(req);
      if (recentFailures(ip).length >= LOGIN_LIMIT) {
        return sendJson(res, 429, { error: "Too many PIN attempts. Wait 15 minutes." });
      }
      if (!pinMatches(req.body?.pin)) {
        const hits = recentFailures(ip);
        hits.push(Date.now());
        loginFailures.set(ip, hits);
        return sendJson(res, 401, { error: "Wrong PIN" });
      }
      loginFailures.delete(ip);
      const issued = devices.issue(req.body?.name);
      await devices.save();
      setDeviceCookie(req, res, issued.token);
      sendJson(res, 200, { ok: true, token: issued.token, device: issued.device });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/logout", async (req, res, next) => {
    try {
      const device = devices.find(presentedToken(req));
      if (device) devices.revoke(device.id);
      await devices.save();
      res.clearCookie(COOKIE_NAME, { path: "/" });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      next(err);
    }
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
            playfieldFile: cached.playfieldFile,
            logoFile: cached.logoFile,
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

  app.post("/api/leaderboards/:id/archive", requirePin, async (req, res, next) => {
    try {
      await store.archiveLeaderboard(req.params.id);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/leaderboards/:id/restore", requirePin, async (req, res, next) => {
    try {
      await store.restoreLeaderboard(req.params.id);
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/leaderboards/:id/archive", requirePin, async (req, res, next) => {
    try {
      await store.deleteArchivedLeaderboard(req.params.id);
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

  function sendMachineFile(res, board, file) {
    if (!board || !file || !cacheDir) return res.status(404).send("No machine art");
    const resolved = path.resolve(cacheDir, file);
    if (!isInside(cacheDir, resolved) || !fs.existsSync(resolved)) {
      return res.status(404).send("No machine art");
    }
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(resolved);
  }

  function machineById(id) {
    return store.findBoard(id) || (store.getState().archivedLeaderboards || []).find((board) => board.id === id);
  }

  app.get("/media/machines/:id/art", (req, res) => {
    const board = machineById(req.params.id);
    sendMachineFile(res, board, board?.artFile);
  });

  app.get("/media/machines/:id/playfield", (req, res) => {
    const board = machineById(req.params.id);
    sendMachineFile(res, board, board?.playfieldFile);
  });

  app.get("/media/machines/:id/logo", (req, res) => {
    const board = machineById(req.params.id);
    sendMachineFile(res, board, board?.logoFile);
  });

  app.put("/api/displays", requirePin, async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.screens && typeof body.screens === "object") {
        for (const slot of ["1", "2", "3"]) {
          const screen = body.screens[slot];
          if (!screen) continue;
          if (screen.content !== undefined && !canonicalDisplayContent(screen.content)) {
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
    const message = JSON.stringify({ type: "kiosk", kiosk: payload().kiosk });
    for (const client of clients) {
      if (client.readyState === 1 && client.trusted !== false) client.send(message);
    }
    sendJson(res, 200, { ok: true, count: monitors.length });
  });

  app.put("/api/airplay/target", lanRequired, requirePin, async (req, res, next) => {
    try {
      const target = String(req.body?.target || "");
      if (!AIRPLAY_TARGETS.includes(target)) {
        return sendJson(res, 400, { error: "Pick screen 1, 2, 3, all, or off" });
      }
      if (["1", "2", "3"].includes(target)) assertOpen(target);
      await localStore.update({ airplay: { target } });
      const running = airplayController.ensureRunning?.({ bounds: boundsForSlot(targetSlots(target)[0]) }) || { ok: false };
      if (target !== "off" && running && running.ok === false) {
        console.warn(`AirPlay helper: ${running.error}`);
      }
      await syncAirplayPresentations();
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/airplay/probe", loopbackRequired, async (req, res, next) => {
    try {
      if (typeof airplayController.noteProbe === "function") {
        airplayController.noteProbe(Boolean(req.body?.placed), { notify: false });
      }
      await syncAirplayPresentations();
      broadcast();
      sendJson(res, 200, { ok: true, active: Boolean(airplayController.isActive?.()) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/plugs/discover", lanRequired, requirePin, async (req, res, next) => {
    try {
      await plugService.discover();
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/plugs/assignments", lanRequired, requirePin, async (req, res, next) => {
    try {
      await plugService.assign(req.body?.assignments || req.body);
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/plugs/schedule", lanRequired, requirePin, async (req, res, next) => {
    try {
      await plugService.setSchedule(req.body || {});
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/plugs/refresh", lanRequired, requirePin, async (req, res, next) => {
    try {
      await plugService.refresh();
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/plugs/power", lanRequired, requirePin, async (req, res, next) => {
    try {
      await plugService.setAll(Boolean(req.body?.on));
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/plugs/:slot/power", lanRequired, requirePin, async (req, res, next) => {
    try {
      const slot = String(req.params.slot);
      if (!["1", "2", "3"].includes(slot)) return sendJson(res, 404, { error: "Unknown display" });
      await plugService.setSlotPower(slot, Boolean(req.body?.on));
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/media/settings", lanRequired, requirePin, async (req, res, next) => {
    try {
      const patch = {};
      if (req.body?.allAges !== undefined) patch.allAges = req.body.allAges !== false;
      if (Array.isArray(req.body?.disabledIds)) patch.disabledIds = req.body.disabledIds;
      await localStore.update({ media: patch });
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/media/catalog/:id", lanRequired, requirePin, async (req, res, next) => {
    try {
      const item = catalogItems.find((entry) => entry.id === req.params.id);
      if (!item) return sendJson(res, 404, { error: "Unknown video" });
      const disabled = new Set(currentConfig().media.disabledIds || []);
      if (req.body?.disabled === false) disabled.delete(item.id);
      else disabled.add(item.id);
      await localStore.update({ media: { disabledIds: [...disabled] } });
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/media/failure", lanRequired, (req, res) => {
    const reason = req.body?.reason === "failed" ? "failed" : "stalled";
    const id = String(req.body?.id || "").replace(/[^\w:-]/g, "").slice(0, 80);
    const title = String(req.body?.title || "").replace(/\s+/g, " ").slice(0, 80);
    const root = dataDir || path.dirname(store.filePath);
    const dir = path.join(root, "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "video.log"), `${new Date().toISOString()} ${reason} ${id} ${title}\n`);
    sendJson(res, 200, { ok: true });
  });

  app.put("/api/media/:id", lanRequired, requirePin, async (req, res, next) => {
    try {
      await library.update(req.params.id, req.body || {});
      if (playback?.videoId === req.params.id && currentConfig().media.allAges && library.get(req.params.id)?.allAges === false) {
        playback = null;
      }
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/media/:id", lanRequired, requirePin, async (req, res, next) => {
    try {
      await library.remove(req.params.id);
      if (playback?.playlist?.includes(req.params.id)) playback = null;
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/media/play", lanRequired, requirePin, async (req, res, next) => {
    try {
      const mode = String(req.body?.mode || "one");
      const ids = Array.isArray(req.body?.ids) && req.body.ids.length
        ? req.body.ids.map(String)
        : [String(req.body?.id || "")];
      const videos = ids.filter(Boolean).map((id) => videoForPlay(id));
      if (!videos.length) return sendJson(res, 400, { error: "Pick a video" });
      const slots = slotsForPlayback(mode, req.body?.slot);
      playback = {
        videoId: videos[0].id,
        mode,
        slots,
        startedAt: Date.now(),
        loop: req.body?.loop !== false,
        playlist: videos.map((video) => video.id),
        index: 0,
      };
      console.log(`Playing ${videos[0].title} (${mode}) on display ${slots.join(", ")}`);
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/media/stop", lanRequired, requirePin, (req, res) => {
    playback = null;
    broadcast();
    sendJson(res, 200, payload());
  });

  app.post("/api/media/next", lanRequired, (req, res) => {
    if (!playback || playback.playlist.length < 2) return sendJson(res, 200, payload());
    const from = String(req.body?.videoId || playback.videoId);
    if (from !== playback.videoId) return sendJson(res, 200, payload());
    const nextIndex = playback.index + 1;
    if (nextIndex >= playback.playlist.length) {
      if (!playback.loop) {
        playback = null;
        broadcast();
        return sendJson(res, 200, payload());
      }
      playback.index = 0;
    } else {
      playback.index = nextIndex;
    }
    playback.videoId = playback.playlist[playback.index];
    playback.startedAt = Date.now();
    broadcast();
    sendJson(res, 200, payload());
  });

  app.post("/api/media", lanRequired, requirePin, async (req, res, next) => {
    const declared = Number(req.get("content-length") || 0);
    if (declared > MAX_BYTES) {
      req.resume();
      return sendJson(res, 413, { error: "That video is over 8 GB." });
    }
    const filename = String(req.get("x-filename") || "video.mp4");
    const mime = String(req.get("content-type") || "");
    const folder = normalizeFolder(req.get("x-folder") || "library");
    if (!folder) return sendJson(res, 400, { error: "Folder must be library, halloween, or christmas" });
    if (!extensionFor(filename, mime)) {
      req.resume();
      return sendJson(res, 400, { error: "Upload an mp4, m4v, webm, mov, or mkv video" });
    }
    let item;
    try {
      item = await library.add({
        filename,
        mime,
        folder,
        title: req.get("x-title"),
        tags: req.get("x-tags"),
        allAges: req.get("x-all-ages"),
        inRotation: req.get("x-in-rotation"),
        loop: req.get("x-loop"),
      });
    } catch (err) {
      req.resume();
      return next(err);
    }
    const dest = library.filePath(item);
    const stream = fs.createWriteStream(dest);
    let received = 0;
    let failed = null;
    const fail = (error) => {
      if (failed) return;
      failed = error;
      req.destroy();
      stream.destroy();
      fs.promises.unlink(dest).catch(() => {});
      library.remove(item.id).catch(() => {});
      if (!res.headersSent) sendJson(res, error.status || 400, { error: error.message || "Upload failed" });
    };
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BYTES) {
        fail(Object.assign(new Error("That video is over 8 GB."), { status: 413 }));
        return;
      }
      if (!stream.write(chunk)) req.pause();
    });
    stream.on("drain", () => req.resume());
    req.on("error", (err) => fail(err));
    stream.on("error", (err) => fail(err));
    req.on("end", () => {
      if (failed) return;
      stream.end();
    });
    stream.on("finish", async () => {
      if (failed || !received) {
        await library.remove(item.id).catch(() => {});
        if (!res.headersSent) {
          sendJson(res, failed?.status || 400, { error: failed?.message || "That file is empty." });
        }
        return;
      }
      item.bytes = received;
      await library.save();
      console.log(`Saved video ${item.title} (${received} bytes) in media/${item.folder}`);
      broadcast();
      if (!res.headersSent) sendJson(res, 200, payload());
    });
    req.on("close", () => {
      if (!req.complete && !failed) fail(Object.assign(new Error("Upload interrupted"), { status: 400 }));
    });
  });

  app.get("/media/videos/:id", lanRequired, (req, res) => {
    const item = library.get(String(req.params.id || ""));
    if (!item) return res.status(404).send("Not found");
    const filePath = path.resolve(library.filePath(item));
    if (!isInside(path.join(mediaRoot, item.folder), filePath)) {
      return res.status(404).send("Not found");
    }
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(filePath);
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
      if (source === "airplay") {
        await localStore.update({ airplay: { target: slot } });
        airplayController.ensureRunning?.({ bounds: boundsForSlot(slot) });
        await syncAirplayPresentations();
        broadcast();
        return sendJson(res, 200, payload());
      }
      const session = await presentations.start({
        slot,
        source,
        url: req.body?.url,
        idleMinutes: currentConfig().presentation.idleMinutes,
      });
      if (session.code) {
        console.log(`Presentation on display ${slot}: ${source}, code ${session.code}`);
      } else {
        console.log(`Presentation on display ${slot}: ${source}`);
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
      if (existing?.source === "airplay") {
        await localStore.update({ airplay: { target: "off" } });
        await endAirplayPresentations();
      } else {
        await presentations.end(slot);
      }
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

  function safeHeader(value) {
    try {
      return decodeURIComponent(value || "");
    } catch {
      return String(value || "");
    }
  }

  function guestPublicUrl(req) {
    const configured = currentConfig().photos.publicBaseUrl;
    if (configured) return `${configured.replace(/\/$/, "")}/app`;
    const host = getLanIPv4s()[0];
    if (host) return `http://${host}:${currentConfig().port}/app`;
    return `${req.protocol}://${req.get("host")}/app`;
  }

  app.get("/api/guest-qr", async (req, res, next) => {
    try {
      const QRCode = require("qrcode");
      const png = await QRCode.toBuffer(guestPublicUrl(req), {
        margin: 1,
        width: 480,
        color: { dark: "#1a1916", light: "#f8f8f5" },
      });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(png);
    } catch (err) {
      next(err);
    }
  });

  const proofDir = path.join(dataDir || path.dirname(store.filePath), "score-proofs");

  async function saveScoreProof(buffer) {
    const sharp = require("sharp");
    const processed = await sharp(buffer, { failOn: "none", animated: false })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    const proofFile = `${crypto.randomUUID()}.jpg`;
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(path.join(proofDir, proofFile), processed);
    return proofFile;
  }

  app.post("/api/scores", (req, res, next) => {
    const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (mime.startsWith("image/")) {
      return express.raw({ limit: "12mb", type: () => true })(req, res, () => acceptScore(req, res, next, true));
    }
    return acceptScore(req, res, next, false);
  });

  async function acceptScore(req, res, next, withPhoto) {
    try {
      let boardId;
      let name;
      let score;
      let proofFile = null;
      if (withPhoto) {
        const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
          return sendJson(res, 400, { error: "Upload a JPEG, PNG, or WEBP of the score." });
        }
        boardId = safeHeader(req.get("x-board-id"));
        name = safeHeader(req.get("x-name"));
        score = safeHeader(req.get("x-score"));
        proofFile = await saveScoreProof(req.body);
      } else {
        boardId = req.body?.boardId;
        name = req.body?.name;
        score = req.body?.score;
      }
      const submission = await store.submitScore({
        boardId,
        name,
        score,
        proofFile,
        ip: req.socket?.remoteAddress || "",
      });
      broadcast();
      sendJson(res, 200, {
        submission: {
          id: submission.id,
          boardId: submission.boardId,
          name: submission.name,
          score: submission.score,
          status: submission.status,
          createdAt: submission.createdAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  app.post("/api/scores/:id/approve", requirePin, async (req, res, next) => {
    try {
      await store.reviewScore(req.params.id, "approved");
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/scores/:id/reject", requirePin, async (req, res, next) => {
    try {
      await store.reviewScore(req.params.id, "rejected");
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.get("/media/score-proofs/:file", requirePin, (req, res) => {
    const name = String(req.params.file || "");
    if (!/^[0-9a-f-]{36}\.jpg$/i.test(name)) return res.status(404).send("Not found");
    const submission = (store.getState().scoreSubmissions || []).find((row) => row.proofFile === name);
    if (!submission) return res.status(404).send("Not found");
    const filePath = path.resolve(proofDir, name);
    if (!isInside(proofDir, filePath) || !fs.existsSync(filePath)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-store");
    res.type("jpeg").sendFile(filePath);
  });

  app.get("/api/guest-photos/feed", (_req, res) => {
    sendJson(res, 200, { photos: album.feed(), events: album.events });
  });

  app.post(
    "/api/guest-photos",
    express.raw({ limit: "25mb", type: () => true }),
    async (req, res, next) => {
      try {
        const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) {
          return sendJson(res, 400, { error: "Upload a JPEG, PNG, or WEBP photo." });
        }
        const photo = await album.ingest(req.body, {
          caption: safeHeader(req.get("x-caption")),
          guestName: safeHeader(req.get("x-guest-name")),
          eventName: currentConfig().photos.eventName,
          autoApprove: currentConfig().photos.autoApprove,
          ip: req.socket?.remoteAddress || "",
        });
        broadcast();
        sendJson(res, 200, { photo });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get("/api/guest-photos", requirePin, (_req, res) => {
    sendJson(res, 200, { photos: album.list(), events: album.events, settings: currentConfig().photos });
  });

  app.put("/api/guest-photos/settings", requirePin, async (req, res, next) => {
    try {
      await localStore.update({ photos: req.body || {} });
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/guest-photos/:id/approve", requirePin, async (req, res, next) => {
    try {
      const photo = await album.setStatus(req.params.id, "approved");
      broadcast();
      sendJson(res, 200, { photo });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/guest-photos/:id/reject", requirePin, async (req, res, next) => {
    try {
      const photo = await album.setStatus(req.params.id, "rejected");
      broadcast();
      sendJson(res, 200, { photo });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/guest-photos/:id/archive", requirePin, async (req, res, next) => {
    try {
      const photo = await album.archivePhoto(req.params.id);
      broadcast();
      sendJson(res, 200, { photo });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/guest-photos/:id/restore", requirePin, async (req, res, next) => {
    try {
      const photo = await album.restorePhoto(req.params.id);
      broadcast();
      sendJson(res, 200, { photo });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/guest-photos/zip", requirePin, async (req, res, next) => {
    try {
      await album.zipApproved(res);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/guest-photos/events/:id/clear", requirePin, async (req, res, next) => {
    try {
      const result = await album.clearEvent(req.params.id);
      broadcast();
      sendJson(res, 200, result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/guest-photos/events/:id/zip", requirePin, async (req, res, next) => {
    try {
      await album.zipEvent(req.params.id, res);
    } catch (err) {
      next(err);
    }
  });

  app.get("/media/guest/:file", (req, res) => {
    const name = String(req.params.file || "");
    if (!/^[0-9a-f-]{36}\.jpg$/i.test(name)) return res.status(404).send("Not found");
    const id = name.slice(0, -4);
    const photo = album.photos.find((item) => item.id === id);
    if (!photo) return res.status(404).send("Not found");
    if (photo.status !== "approved" && !isAuthed(req)) return res.status(404).send("Not found");
    const filePath = album.filePath(photo);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-store");
    if (String(req.query.download || "") === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="${id}.jpg"`);
    }
    res.type("jpeg").sendFile(filePath);
  });

  app.get("/media/starter/:id", lanRequired, (req, res) => {
    const item = catalogItems.find((entry) => entry.id === req.params.id);
    const filePath = item ? starterFile(mediaRoot, item) : null;
    if (!filePath) return res.status(404).send("Not downloaded");
    res.sendFile(filePath);
  });

  app.get("/api/admin/bootstrap", requirePin, (req, res) => {
    const host = `${req.protocol}://${req.get("host")}`;
    sendJson(res, 200, {
      version: pkg.version,
      pinHint: "PIN is a convenience gate. This device stays signed in.",
      devices: devices.list(),
      joinUrl: `${host}/admin/join?token=${devices.data.joinToken}`,
      defaultPin: DEFAULT_PIN,
    });
  });

  app.get("/api/admin/join-qr", requirePin, async (req, res, next) => {
    try {
      const QRCode = require("qrcode");
      const host = `${req.protocol}://${req.get("host")}`;
      const png = await QRCode.toBuffer(`${host}/admin/join?token=${devices.data.joinToken}`, {
        margin: 1,
        width: 480,
        color: { dark: "#1a1916", light: "#f8f8f5" },
      });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-store");
      res.send(png);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/admin/join", lanRequired, async (req, res, next) => {
    try {
      if (!devices.joinMatches(req.body?.token)) {
        return sendJson(res, 401, { error: "That admin link is no longer valid." });
      }
      const issued = devices.issue(req.body?.name || "Joined iPad");
      await devices.save();
      setDeviceCookie(req, res, issued.token);
      sendJson(res, 200, { ok: true, token: issued.token, device: issued.device });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/devices/:id", requirePin, async (req, res, next) => {
    try {
      devices.revoke(req.params.id);
      await devices.save();
      sendJson(res, 200, { devices: devices.list() });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/devices/revoke-all", requirePin, async (req, res, next) => {
    try {
      devices.revokeAll();
      await devices.save();
      res.clearCookie(COOKIE_NAME, { path: "/" });
      sendJson(res, 200, { ok: true, devices: [] });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/pin", requirePin, async (req, res, next) => {
    try {
      const nextPin = await changePin(req.body?.pin);
      sendJson(res, 200, { ok: true, pin: nextPin });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/pin/reset", requirePin, async (req, res, next) => {
    try {
      await changePin(DEFAULT_PIN);
      sendJson(res, 200, { ok: true, pin: DEFAULT_PIN });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/motion", requirePin, async (req, res, next) => {
    try {
      await localStore.update({ motion: req.body?.motion });
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/youtube", requirePin, async (req, res, next) => {
    try {
      const theme = ["pinnacle", "halloween", "christmas"].includes(req.body?.theme) ? req.body.theme : null;
      const parsed = parseYoutubeInput(req.body?.input || req.body?.url || req.body?.id);
      if (!theme || !parsed) {
        return sendJson(res, 400, { error: "Paste a YouTube link or playlist id for a theme." });
      }
      const current = currentConfig().youtube;
      const list = current[theme].filter((item) => !(item.id === parsed.id && item.kind === parsed.kind));
      list.push({
        id: parsed.id,
        kind: parsed.kind,
        title: String(req.body?.title || "").trim().slice(0, 80) || (parsed.kind === "playlist" ? "Playlist" : "Video"),
      });
      await localStore.update({ youtube: { ...current, [theme]: list } });
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/youtube", requirePin, async (req, res, next) => {
    try {
      const theme = req.body?.theme;
      const current = currentConfig().youtube;
      if (!current[theme]) return sendJson(res, 400, { error: "Unknown theme" });
      const list = current[theme].filter((item) => !(item.id === req.body?.id && item.kind === req.body?.kind));
      await localStore.update({ youtube: { ...current, [theme]: list } });
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/youtube/play", requirePin, async (req, res, next) => {
    try {
      const parsed = parseYoutubeInput(req.body?.input || req.body?.id);
      if (!parsed) return sendJson(res, 400, { error: "That is not a YouTube link." });
      const slots = slotsForPlayback(req.body?.mode || "sync", req.body?.slot);
      playback = {
        kind: "youtube",
        videoId: parsed.id,
        youtubeKind: parsed.kind,
        title: String(req.body?.title || "YouTube").slice(0, 80),
        mode: req.body?.mode || "sync",
        slots,
        startedAt: Date.now(),
      };
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/updates/settings", requirePin, async (req, res, next) => {
    try {
      const updated = await localStore.update({
        updates: {
          enabled: req.body?.enabled !== false,
          nightlyAt: req.body?.nightlyAt,
        },
      });
      let rescheduled = false;
      if (process.platform === "win32" && !process.env.NODE_TEST_CONTEXT) {
        launchRegisterTasks({ appRoot });
        rescheduled = true;
      }
      sendJson(res, 200, {
        ok: true,
        rescheduled,
        updates: updateFields(updated),
        note: "Saved. The PC uses this switch at sign-in and this time each night.",
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/updates/now", requirePin, async (req, res, next) => {
    try {
      const updates = updateFields(currentConfig());
      if (process.env.NODE_TEST_CONTEXT) {
        return sendJson(res, 200, {
          version: pkg.version,
          commit: updates.commit,
          started: false,
          applied: false,
          note: `Version ${pkg.version}. No install was started. The data folder stays put.`,
        });
      }
      if (process.platform !== "win32") {
        return sendJson(res, 200, {
          version: pkg.version,
          commit: updates.commit,
          started: false,
          applied: false,
          note: "Update now runs on the Windows kiosk. This computer was not changed.",
        });
      }
      launchDetachedUpdate({ appRoot, mode: "now" });
      sendJson(res, 200, {
        version: pkg.version,
        commit: updates.commit,
        started: true,
        applied: false,
        note: "Update started. The wall comes back when it finishes. Venue data is not changed.",
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/sw.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "sw.js"));
  });

  app.get("/admin/sw.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Service-Worker-Allowed", "/admin");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "admin-sw.js"));
  });

  app.get("/media/uploads/:file", lanRequired, (req, res) => {
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

  app.get(["/", "/app"], (_req, res) => {
    res.sendFile(path.join(publicDir, "guest.html"));
  });

  app.get("/admin/join", (_req, res) => {
    res.sendFile(path.join(publicDir, "join.html"));
  });

  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(publicDir, "control.html"));
  });

  app.get("/control", (_req, res) => {
    res.redirect(302, "/admin");
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
      if (role === "viewer" && socket.trusted === false) {
        socket.send(JSON.stringify({ type: "present-error", error: "That screen is only on the venue network." }));
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
      if (session?.source === "airplay") {
        await localStore.update({ airplay: { target: "off" } });
        await endAirplayPresentations();
      }
      broadcast();
    }
  }

  store.onChange(() => broadcast());

  try {
    airplayController.ensureRunning?.();
  } catch (err) {
    console.error(err);
  }

  const plugTimer = setInterval(() => {
    const before = JSON.stringify(plugService.publicState());
    plugService.tick().then(() => {
      if (JSON.stringify(plugService.publicState()) !== before) broadcast();
    }).catch((err) => console.error(err));
  }, 30000);
  if (typeof plugTimer.unref === "function") plugTimer.unref();

  const sweepTimer = setInterval(async () => {
    try {
      const ended = await presentations.endExpired();
      if (!ended.length) return;
      console.log(`Ended idle presentation on display ${ended.map((session) => session.slot).join(", ")}.`);
      broadcast();
    } catch (err) {
      console.error(err);
    }
  }, 15000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket, req) => {
      socket.trusted = isLanAddress(forwardedAddress(req));
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.send(JSON.stringify({ type: "state", ...stateFor(socket.trusted) }));
      socket.on("message", (raw) => {
        handleClientMessage(socket, raw).catch((err) => console.error(err));
      });
    });
    return wss;
  }

  return { app, attachWebSocket, presentations };
}

module.exports = { createApp };
