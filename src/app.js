const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");
const { resolveLogos, resolvePhotos, LOGO_KEYS, PHOTO_KEYS } = require("./logos");
const { AMENITIES } = require("./amenities");
const { buildPlaylist, planRotation, currentTick, replacementFor } = require("./playlist");
const { createOpdb, manufacturerName, manufactureYear, safeId, BUILTIN_OPDB_API_KEY } = require("./opdb");
const { sendByteRange } = require("./media-range");
const { createConfigStore, ensureGuestSecret } = require("./config");
const { AirplayController, AIRPLAY_TARGETS } = require("./airplay");
const { getLanIPv4s, isLanAddress, forwardedAddress, lanRequired, loopbackRequired } = require("./lan");
const { Presentations } = require("./presentations");
const { canonicalDisplayContent, layoutForDisplays, mapDisplaysToSlots } = require("./displays");
const { PlugService, createPlugClient, createMockPlugClient } = require("./plugs");
const { MediaLibrary, MAX_BYTES, extensionFor, normalizeFolder } = require("./media");
const { DeviceStore, COOKIE_NAME: DEVICE_COOKIE, DEVICE_MAX_AGE_MS, pinIsValid, DEFAULT_PIN } = require("./devices");
const { GuestAlbum } = require("./photos");
const { loadCatalog, starterFile, starterCards } = require("./catalog");
const { bundledFile } = require("./bundled");
const { createClipCache } = require("./clip-cache");
const { prepareLogoSvg } = require("./logo-color");
const {
  GUEST_COOKIE,
  COOKIE_MS,
  guestDay,
  guestToken,
  tokenMatches,
  signGuestCookie,
  readGuestCookie,
  scanPage,
} = require("./guest-link");
const { detectTailscale, startQuickTunnel } = require("./public-access");
const { maskProfanity } = require("./text-filter");
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
const CSRF_COOKIE = "pl_csrf";
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

function machineFileUrl(board, file) {
  if (!board || !file) return null;
  return `/media/machines/${encodeURIComponent(board.id)}/file/${encodeURIComponent(path.basename(file))}`;
}

function boardArtUrls(board) {
  const urls = [];
  const push = (url) => {
    if (url && !urls.includes(url)) urls.push(url);
  };
  push(machineAssetUrl(board, "art"));
  push(machineAssetUrl(board, "playfield"));
  push(machineAssetUrl(board, "logo"));
  for (const file of board?.imageFiles || []) push(machineFileUrl(board, file));
  for (const row of board?.rows || []) {
    if (row?.proofFile && row.showOnWall !== false && /^[0-9a-f-]{36}\.jpg$/i.test(row.proofFile)) {
      push(`/media/score-proofs/${row.proofFile}`);
    }
  }
  return urls;
}

function publicLeaderboards(leaderboards) {
  return (leaderboards || []).map((board) => {
    const artUrls = boardArtUrls(board);
    return {
      ...board,
      artUrl: artUrls[0] || machineAssetUrl(board, "art"),
      artUrls,
      playfieldUrl: machineAssetUrl(board, "playfield"),
      logoUrl: machineAssetUrl(board, "logo"),
      artFile: undefined,
      playfieldFile: undefined,
      logoFile: undefined,
      imageFiles: undefined,
    };
  });
}

function effectiveRotation(state) {
  const override = Number.parseInt(process.env.PINBALL_ROTATION_SEC || "", 10);
  if (Number.isFinite(override) && override >= 1 && override <= 120) {
    return { intervalSec: override, minInterval: 1 };
  }
  return { intervalSec: state?.rotation?.intervalSec, minInterval: 10 };
}

function createApp({
  store,
  pin,
  publicDir,
  logosDir,
  photosDir,
  opdbApiKey = BUILTIN_OPDB_API_KEY,
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
  clock = null,
  dataDir = null,
  appRoot = path.join(__dirname, ".."),
  clipCache = false,
  clipIdList = null,
  publicProbe = null,
}) {
  const app = express();
  app.set("trust proxy", "loopback");
  const opdb = createOpdb({
    apiKey: opdbApiKey,
    cacheDir,
    fetchImpl,
  });
  const externalConfig = Boolean(configStore);
  const localStore = configStore || createConfigStore(path.join(os.tmpdir(), `pinball-land-${crypto.randomUUID()}`, "config.json"));
  ensureGuestSecret(localStore.path);
  let activePin = pin;
  const uploadRoot = uploadsDir || path.join(os.tmpdir(), `pinball-land-uploads-${crypto.randomUUID()}`);
  const presentations = new Presentations({
    idleMinutes: localStore.get().presentation.idleMinutes,
    now,
  });
  let restartToken = 0;
  const clockNow = typeof clock === "function" ? clock : () => Date.now();
  const videoMemory = {
    1: { gen: 0, id: "" },
    2: { gen: 0, id: "" },
    3: { gen: 0, id: "" },
  };
  const slotFallback = {};
  const seenVideoLog = new Set();
  const motionSync = {
    seed: 0x50494e,
    epoch: Date.now(),
    worldWidth: 5760,
    worldHeight: 1080,
    sliceWidth: 1920,
  };
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
    client: process.env.PINBALL_PLUG_MOCK === "1" ? createMockPlugClient() : createPlugClient(),
    getConfig: () => localStore.get(),
    updateConfig: (patch) => localStore.update(patch),
  });
  const deviceFile = devicesPath || path.join(path.dirname(uploadRoot), "devices.json");
  const devices = new DeviceStore(deviceFile);
  const album = new GuestAlbum({
    root: guestPhotosDir || path.join(path.dirname(uploadRoot), "guest-photos"),
  });
  const catalogItems = loadCatalog(catalogPath || path.join(__dirname, "..", "media", "catalog.json"));
  const clipIds = Array.isArray(clipIdList) && clipIdList.length
    ? clipIdList
    : String(process.env.PINBALL_CLIP_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
  const clips = createClipCache({
    items: catalogItems,
    cacheDir: path.join(mediaRoot, "cache"),
    logFile: path.join(dataDir || path.dirname(mediaRoot), "logs", "video.log"),
    nightlyAt: () => localStore.get().updates?.nightlyAt || "03:17",
    ids: clipIds.length ? clipIds : null,
  });
  if (clipCache || process.env.PINBALL_CLIP_CACHE === "1") clips.start();
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
    const layout = wallLayout(displays);
    const playlist = buildPlaylist(state, {
      videos: library.list(),
      allAges: config.media.allAges,
      pinboard: config.photos.pinboard !== false,
      starters: starterCards(catalogItems, {
        theme: state.theme,
        allAges: config.media.allAges,
        urlFor: (id) => `/media/cache/${id}`,
        disabledIds: config.media.disabledIds,
        isReady: (id) => clips.isReady(id),
      }),
      youtube: config.youtube?.[state.theme] || [],
    });
    const timing = effectiveRotation(state);
    const tick = currentTick(state.rotation.startedAt, timing.intervalSec, clockNow(), timing.minInterval);
    for (const slot of Object.keys(slotFallback)) {
      if (slotFallback[slot].tick !== tick) delete slotFallback[slot];
    }
    const rotationPlan = planRotation(playlist, {
      startedAt: state.rotation.startedAt,
      intervalSec: timing.intervalSec,
      minInterval: timing.minInterval,
      screenCount: displays.count,
      layout,
      now: clockNow(),
      videoMemory,
    });
    for (const [slot, fallback] of Object.entries(slotFallback)) {
      if (fallback.tick === tick && fallback.card) rotationPlan[slot] = fallback.card;
    }
    for (const slot of ["1", "2", "3"]) {
      const card = rotationPlan[slot];
      if (layout[slot]?.content === "video" && card?.type === "video" && card.id && !card.empty) {
        videoMemory[slot] = { gen: videoMemory[slot]?.gen || 0, id: card.id };
      }
    }
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
          playUrl: clips.isReady(item.id) ? `/media/cache/${item.id}` : null,
          cached: clips.isReady(item.id),
        })),
      },
      playback: publicPlayback(),
      motion: config.motion,
      slogans: config.slogans,
      motionSync,
      rotationTiming: timing,
      serverNow: clockNow(),
      version: pkg.version,
      youtube: config.youtube,
      publicAccess: {
        enabled: config.publicAccess?.enabled === true,
        cloudflare: config.publicAccess?.cloudflare === true,
        url: publicStatus.url || "",
        source: publicStatus.source || "",
        detail: publicStatus.detail || "",
      },
      adminAccess: {
        internet: config.admin?.internet !== false,
        longPin: config.admin?.longPin !== false,
      },
      guest: {
        path: "/app",
        publicUrl: entryUrl() || null,
        eventName: config.photos.eventName,
        style: config.photos.style,
        span: config.photos.span,
        autoApprove: config.photos.autoApprove !== false,
        pinboard: config.photos.pinboard !== false,
        paused: config.photos.paused === true,
        qrDay: guestDay(clockNow()),
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
        pinboard: full.guest.pinboard,
        paused: full.guest.paused,
        autoApprove: full.guest.autoApprove,
      },
      serverNow: full.serverNow,
      version: full.version,
      motion: full.motion,
      slogans: full.slogans,
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

  function wallLayout(displays) {
    const layout = layoutForDisplays(displays || currentConfig().displays);
    if (currentConfig().photos?.pinboard === false) {
      for (const slot of Object.values(layout)) {
        if (slot?.content === "pinboard") slot.content = "rotation";
      }
    }
    return layout;
  }

  function assertOpen(slot) {
    if (!["1", "2", "3"].includes(String(slot))) {
      throw Object.assign(new Error("Unknown display"), { status: 404 });
    }
    const layout = wallLayout()[String(slot)];
    if (!layout?.enabled) {
      throw Object.assign(new Error("That display is turned off. Enable it under Displays first."), { status: 400 });
    }
  }

  function enabledSlots() {
    const layout = wallLayout();
    return ["1", "2", "3"].filter((slot) => layout[slot]?.enabled);
  }

  function targetSlots(target, displays) {
    const layout = wallLayout(displays);
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
    const cookies = parseCookies(req.headers?.cookie);
    const headerToken = typeof req.get === "function" ? req.get("x-device-token") : req.headers?.["x-device-token"];
    return cookies[COOKIE_NAME] || headerToken || "";
  }

  function pinMatches(submitted) {
    const given = Buffer.from(String(submitted || ""));
    const expected = Buffer.from(String(currentPin()));
    if (given.length !== expected.length || given.length === 0) return false;
    return crypto.timingSafeEqual(given, expected);
  }

  const loginFailures = new Map();
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_LIMIT = 5;
  const globalLoginFailures = [];
  let publicStatus = { url: "", source: "", detail: "Off. Guests use the venue WiFi.", checkedAt: 0 };
  let tunnel = null;
  let tunnelUrl = "";

  function guestSecret() {
    return currentConfig().guestSecret || ensureGuestSecret(localStore.path);
  }

  function cookieSecure(req) {
    if (req.secure) return true;
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    if (proto === "https") return true;
    const host = String(req.headers.host || "");
    return /\.ts\.net(?::\d+)?$/i.test(host) || /trycloudflare\.com/i.test(host);
  }

  function isPublicRequest(req) {
    if (req.headers["tailscale-funnel"] || req.headers["x-tailscale-funnel"]) return true;
    const host = String(req.headers.host || "").split(":")[0];
    if (/\.ts\.net$/i.test(host) || /trycloudflare\.com$/i.test(host)) return true;
    return !isLanAddress(forwardedAddress(req));
  }

  function stopTunnel() {
    if (tunnel) {
      tunnel.kill();
      tunnel = null;
    }
    tunnelUrl = "";
  }

  async function refreshPublicAccess() {
    const access = currentConfig().publicAccess;
    if (!access?.enabled) {
      stopTunnel();
      publicStatus = { url: "", source: "", detail: "Off. Guests use the venue WiFi.", checkedAt: clockNow() };
      return publicStatus;
    }
    const probe = publicProbe || detectTailscale;
    let found = { url: "", source: "" };
    try {
      found = await probe();
    } catch {
      found = { url: "", source: "" };
    }
    if (found?.url) {
      stopTunnel();
      publicStatus = { url: found.url, source: found.source || "tailscale", detail: "Tailscale Funnel", checkedAt: clockNow() };
      return publicStatus;
    }
    if (access.cloudflare && !process.env.NODE_TEST_CONTEXT) {
      if (!tunnel) {
        tunnel = startQuickTunnel({
          port: currentConfig().port,
          onUrl(url) {
            tunnelUrl = url;
            publicStatus = { url, source: "cloudflare", detail: "Cloudflare quick tunnel", checkedAt: clockNow() };
          },
        });
      }
      if (tunnelUrl) {
        publicStatus = { url: tunnelUrl, source: "cloudflare", detail: "Cloudflare quick tunnel", checkedAt: clockNow() };
        return publicStatus;
      }
    } else {
      stopTunnel();
    }
    publicStatus = {
      url: "",
      source: "",
      detail: "Funnel is not up yet. Guests stay on the venue WiFi until it is.",
      checkedAt: clockNow(),
    };
    return publicStatus;
  }

  const publicTimer = setInterval(() => {
    refreshPublicAccess().catch((err) => console.error(err));
  }, 60_000);
  if (publicTimer.unref) publicTimer.unref();

  function entryUrl() {
    const config = currentConfig();
    const base = config.publicAccess?.enabled && publicStatus.url ? String(publicStatus.url).replace(/\/$/, "") : "";
    if (base) {
      const token = guestToken(guestSecret(), guestDay(clockNow()));
      return `${base}/?k=${token}`;
    }
    const configured = config.photos.publicBaseUrl;
    if (configured) return `${configured.replace(/\/$/, "")}/app`;
    const host = getLanIPv4s()[0];
    if (host) return `http://${host}:${config.port}/app`;
    return "";
  }

  function guestGate(req) {
    if (!isPublicRequest(req)) return true;
    if (isAuthed(req)) return true;
    const cookies = parseCookies(req.headers.cookie);
    if (readGuestCookie(guestSecret(), cookies[GUEST_COOKIE], clockNow())) return true;
    if (tokenMatches(guestSecret(), req.query?.k, clockNow())) return "set";
    return false;
  }

  function setGuestCookie(req, res) {
    const value = signGuestCookie(guestSecret(), clockNow() + COOKIE_MS);
    res.cookie(GUEST_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure(req),
      path: "/",
      maxAge: COOKIE_MS,
    });
  }

  function requireGuest(req, res, next) {
    const gate = guestGate(req);
    if (gate === "set") setGuestCookie(req, res);
    if (gate === true || gate === "set") return next();
    if (String(req.path || req.originalUrl || "").startsWith("/api/")) {
      return sendJson(res, 403, { error: "Scan the QR code at Pinball Land" });
    }
    return res.status(403).type("html").send(scanPage());
  }

  function rateKey(req) {
    const cookie = parseCookies(req.headers.cookie)[GUEST_COOKIE] || "";
    const stamp = cookie ? crypto.createHash("sha256").update(cookie).digest("hex").slice(0, 16) : "open";
    return `${stamp}|${forwardedAddress(req)}`;
  }

  function recentFailures(ip) {
    const now = Date.now();
    const hits = (loginFailures.get(ip) || []).filter((stamp) => now - stamp < LOGIN_WINDOW_MS);
    if (hits.length) loginFailures.set(ip, hits);
    else loginFailures.delete(ip);
    return hits;
  }

  function internetAdminOff(req) {
    return isPublicRequest(req) && currentConfig().admin?.internet === false;
  }

  function longPinBlocks(req) {
    return isPublicRequest(req) && currentConfig().admin?.longPin !== false && String(currentPin()).length < 6;
  }

  function pinAccepted(req, submitted) {
    const value = submitted === undefined ? req.get("x-pin") : submitted;
    if (!pinMatches(value)) return false;
    if (longPinBlocks(req)) return false;
    return true;
  }

  function isAuthed(req) {
    if (internetAdminOff(req)) return false;
    if (devices.find(presentedToken(req))) return true;
    return pinAccepted(req);
  }

  function clientTrusted(req) {
    if (!isPublicRequest(req)) return true;
    if (currentConfig().admin?.internet === false) return false;
    return Boolean(devices.find(presentedToken(req)));
  }

  function recordFailure(ip) {
    const hits = recentFailures(ip);
    hits.push(Date.now());
    loginFailures.set(ip, hits);
    const now = Date.now();
    globalLoginFailures.push(now);
    while (globalLoginFailures.length && now - globalLoginFailures[0] > 60_000) globalLoginFailures.shift();
  }

  function paceMs(ip) {
    if (process.env.NODE_TEST_CONTEXT) return 0;
    const local = recentFailures(ip).length;
    const global = globalLoginFailures.filter((stamp) => Date.now() - stamp < 60_000).length;
    return Math.min(1500, local * 80 + global * 20);
  }

  function csrfBlocks(req) {
    const origin = req.get("origin");
    if (origin) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {
        return true;
      }
      if (host !== req.get("host")) return true;
    }
    if (req.get("x-pin") || req.get("x-device-token")) return false;
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies[COOKIE_NAME]) return false;
    const given = String(req.get("x-csrf") || "");
    const expected = String(cookies[CSRF_COOKIE] || "");
    if (!given || given.length !== expected.length) return true;
    return !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  function setDeviceCookie(req, res, token) {
    const secure = cookieSecure(req);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.cookie(CSRF_COOKIE, crypto.randomBytes(18).toString("base64url"), {
      httpOnly: false,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: SESSION_MAX_AGE_MS,
    });
  }

  function touchDevice(device) {
    const stale = Date.now() - device.lastSeen > 60 * 1000;
    devices.touch(device.id);
    if (stale) devices.save().catch((err) => console.error(err));
  }

  function requirePin(req, res, next) {
    if (internetAdminOff(req)) {
      return sendJson(res, 403, { error: "Admin from the internet is turned off." });
    }
    const device = devices.find(presentedToken(req));
    if (device) {
      if (csrfBlocks(req)) return sendJson(res, 403, { error: "Refresh the admin page and try again." });
      touchDevice(device);
      return next();
    }
    const ip = forwardedAddress(req);
    if (recentFailures(ip).length >= LOGIN_LIMIT) {
      return sendJson(res, 429, { error: "Too many PIN attempts. Wait 15 minutes." });
    }
    if (!pinMatches(req.get("x-pin"))) {
      if (req.get("x-pin")) recordFailure(ip);
      const wait = paceMs(ip);
      if (!wait) return sendJson(res, 401, { error: "PIN required" });
      return setTimeout(() => sendJson(res, 401, { error: "PIN required" }), wait);
    }
    if (longPinBlocks(req)) {
      return sendJson(res, 403, { error: "Set a PIN of 6 or more digits on the venue WiFi before signing in from the internet." });
    }
    if (csrfBlocks(req)) return sendJson(res, 403, { error: "Refresh the admin page and try again." });
    loginFailures.delete(ip);
    return next();
  }

  app.get("/api/health", (_req, res) => {
    sendJson(res, 200, { ok: true });
  });

  app.get("/api/state", (req, res) => {
    sendJson(res, 200, stateFor(clientTrusted(req)));
  });

  app.get("/api/auth", (req, res) => {
    sendJson(res, 200, { ok: isAuthed(req) });
  });

  app.post("/api/login", async (req, res, next) => {
    try {
      if (internetAdminOff(req)) {
        return sendJson(res, 403, { error: "Admin from the internet is turned off." });
      }
      const ip = forwardedAddress(req);
      if (recentFailures(ip).length >= LOGIN_LIMIT) {
        return sendJson(res, 429, { error: "Too many PIN attempts. Wait 15 minutes." });
      }
      const wait = paceMs(ip);
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!pinMatches(req.body?.pin)) {
        recordFailure(ip);
        return sendJson(res, 401, { error: "Wrong PIN" });
      }
      if (longPinBlocks(req)) {
        return sendJson(res, 403, { error: "Set a PIN of 6 or more digits on the venue WiFi before signing in from the internet." });
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
      res.clearCookie(CSRF_COOKIE, { path: "/" });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/slots/:id", requirePin, async (req, res, next) => {
    try {
      if (req.body?.content === "pinboard" && currentConfig().photos.pinboard === false) {
        return sendJson(res, 400, { error: "Pinboard photos are turned off." });
      }
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

  app.put("/api/slogans", requirePin, async (req, res, next) => {
    try {
      await localStore.update({ slogans: req.body || {} });
      broadcast();
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
      const items = req.body?.items && typeof req.body.items === "object" ? { ...req.body.items } : undefined;
      if (items && currentConfig().photos.pinboard === false) items.pinboard = false;
      await store.setRotation({
        enabled: req.body?.enabled,
        intervalSec: req.body?.intervalSec,
        items,
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
            imageFiles: cached.imageFiles || [],
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
      const before = store.getState().leaderboards
      .find((board) => board.id === req.params.id)?.rows
      ?.find((row) => row.id === req.params.rowId);
    await store.updateRow(req.params.id, req.params.rowId, {
        name: req.body?.name,
        score: req.body?.score,
        showOnWall: req.body?.showOnWall,
        removeProof: req.body?.removeProof === true,
      });
    if (req.body?.removeProof === true && before?.proofFile) {
      const proofPath = path.join(dataDir || path.dirname(store.filePath), "score-proofs", before.proofFile);
      fs.rmSync(proofPath, { force: true });
    }
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
    const resolved = resolveLogos(logosDir)[req.params.key];
    if (!resolved?.filePath) return res.status(404).send("Logo file not found");
    res.setHeader("Cache-Control", "no-store");
    if (String(resolved.filePath).endsWith(".svg")) {
      res.type("image/svg+xml");
      return res.send(prepareLogoSvg(fs.readFileSync(resolved.filePath, "utf8")));
    }
    return res.sendFile(resolved.filePath);
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

  app.get("/media/machines/:id/file/:name", (req, res) => {
    const board = machineById(req.params.id);
    const name = path.basename(String(req.params.name || ""));
    const files = [board?.artFile, board?.playfieldFile, board?.logoFile, ...(board?.imageFiles || [])].filter(Boolean);
    const match = files.find((file) => path.basename(file) === name);
    sendMachineFile(res, board, match);
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
      if (req.body?.host) await plugService.addHost(req.body.host);
      await plugService.discover();
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/plugs/add", lanRequired, requirePin, async (req, res, next) => {
    try {
      await plugService.addHost(req.body?.host);
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/plugs/account", lanRequired, requirePin, async (req, res, next) => {
    try {
      await plugService.setAccount(req.body || {});
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
    const event = String(req.body?.event || req.body?.reason || "event").replace(/[^\w-]/g, "").slice(0, 40) || "event";
    const id = String(req.body?.id || "").replace(/[^\w:-]/g, "").slice(0, 80);
    const title = String(req.body?.title || "").replace(/\s+/g, " ").slice(0, 80);
    const code = Number.isFinite(Number(req.body?.code)) ? Number(req.body.code) : "";
    const networkState = Number.isFinite(Number(req.body?.networkState)) ? Number(req.body.networkState) : "";
    const readyState = Number.isFinite(Number(req.body?.readyState)) ? Number(req.body.readyState) : "";
    const currentTime = Number.isFinite(Number(req.body?.currentTime)) ? Number(req.body.currentTime).toFixed(2) : "";
    const src = String(req.body?.src || "").replace(/\s+/g, "").slice(0, 180);
    const slot = ["1", "2", "3"].includes(String(req.body?.slot || "")) ? String(req.body.slot) : "";
    const root = dataDir || path.dirname(store.filePath);
    const dir = path.join(root, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const nowMs = clockNow();
    const noisy = event === "waiting" || event === "suspend" || event === "stalled" || event === "abort" || event === "emptied";
    const dedupeKey = `${slot}:${id}:${event}`;
    if (!noisy || !seenVideoLog.has(dedupeKey)) {
      if (noisy) seenVideoLog.add(dedupeKey);
      fs.appendFileSync(
        path.join(dir, "video.log"),
        `${new Date(nowMs).toISOString()} event=${event} id=${id} slot=${slot} title="${title}" code=${code} networkState=${networkState} readyState=${readyState} currentTime=${currentTime} src=${src}\n`,
      );
    }
    const state = store.getState();
    const layout = wallLayout(currentConfig().displays);
    let changed = false;
    if (event === "ended" && slot && layout[slot]?.content === "video") {
      const mem = videoMemory[slot] || { gen: 0, id: "" };
      videoMemory[slot] = { gen: mem.gen + 1, id: "" };
      changed = true;
    }
    if (event === "give-up" && slot) {
      const timing = effectiveRotation(state);
      const tick = currentTick(state.rotation.startedAt, timing.intervalSec, nowMs, timing.minInterval);
      const plan = payload().rotationPlan;
      const failed = new Set(Array.isArray(req.body?.failedIds) ? req.body.failedIds.map(String) : [id]);
      slotFallback[slot] = {
        tick,
        card: replacementFor(plan, slot, payload().playlist, { failedIds: failed, salt: `${slot}:give-up` }),
      };
      if (layout[slot]?.content === "video") videoMemory[slot] = { gen: (videoMemory[slot]?.gen || 0) + 1, id: "" };
      changed = true;
    }
    if (changed) broadcast();
    sendJson(res, 200, { ok: true, blockedUntil: null });
  });

  app.get("/api/media/cache", lanRequired, (req, res) => {
    sendJson(res, 200, { clips: clips.snapshot() });
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

  app.get("/media/bundled/:file", (req, res) => {
    const filePath = bundledFile(appRoot, req.params.file);
    if (!filePath) return res.status(404).send("Not found");
    sendByteRange(req, res, filePath);
  });

  app.get("/media/videos/:id", lanRequired, (req, res) => {
    const item = library.get(String(req.params.id || ""));
    if (!item) return res.status(404).send("Not found");
    const filePath = path.resolve(library.filePath(item));
    if (!isInside(path.join(mediaRoot, item.folder), filePath)) {
      return res.status(404).send("Not found");
    }
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
    sendByteRange(req, res, filePath);
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
    const entry = entryUrl();
    if (entry) return entry;
    return `${req.protocol}://${req.get("host")}/app`;
  }

  app.get("/api/guest-qr", async (req, res, next) => {
    try {
      if (isPublicRequest(req) && !isAuthed(req)) return sendJson(res, 404, { error: "Not found" });
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
    requireGuest(req, res, () => {
      const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (mime.startsWith("image/")) {
        return express.raw({ limit: "12mb", type: () => true })(req, res, () => acceptScore(req, res, next, true));
      }
      return acceptScore(req, res, next, false);
    });
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
        name = maskProfanity(safeHeader(req.get("x-name")));
        score = safeHeader(req.get("x-score"));
        proofFile = await saveScoreProof(req.body);
      } else {
        boardId = req.body?.boardId;
        name = maskProfanity(req.body?.name);
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
      await store.reviewScore(req.params.id, "approved", { showPhoto: req.body?.showPhoto !== false });
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

  app.get("/media/score-proofs/:file", (req, res) => {
    const name = String(req.params.file || "");
    if (!/^[0-9a-f-]{36}\.jpg$/i.test(name)) return res.status(404).send("Not found");
    const state = store.getState();
    const onBoard = [...(state.leaderboards || []), ...(state.archivedLeaderboards || [])].some((board) =>
      (board.rows || []).some((row) => row.proofFile === name)
    );
    const submission = (state.scoreSubmissions || []).find((row) => row.proofFile === name);
    if (!onBoard && !(submission && isAuthed(req))) return res.status(404).send("Not found");
    const filePath = path.resolve(proofDir, name);
    if (!isInside(proofDir, filePath) || !fs.existsSync(filePath)) return res.status(404).send("Not found");
    res.setHeader("Cache-Control", "no-store");
    res.type("jpeg").sendFile(filePath);
  });

  app.get("/api/guest-photos/feed", requireGuest, (_req, res) => {
    sendJson(res, 200, { photos: album.feed(), events: album.events });
  });

  app.post(
    "/api/guest-photos",
    requireGuest,
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
          paused: currentConfig().photos.paused,
          ip: rateKey(req),
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

  async function syncPinboardFlag() {
    const state = store.getState();
    if (currentConfig().photos.pinboard === false) {
      if (state.rotation?.items?.pinboard !== false) {
        await store.setRotation({ items: { pinboard: false } });
      }
      for (const id of ["1", "2", "3"]) {
        if (state.slots?.[id]?.content === "pinboard") {
          await store.setSlot(id, { content: "rotation" });
        }
      }
    }
  }

  app.put("/api/guest-photos/settings", requirePin, async (req, res, next) => {
    try {
      await localStore.update({ photos: req.body || {} });
      await syncPinboardFlag();
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/public-access", requirePin, async (req, res, next) => {
    try {
      const current = currentConfig().publicAccess || {};
      await localStore.update({
        publicAccess: {
          enabled: req.body?.enabled === undefined ? current.enabled === true : req.body.enabled === true,
          cloudflare: req.body?.cloudflare === undefined ? current.cloudflare === true : req.body.cloudflare === true,
        },
      });
      await refreshPublicAccess();
      broadcast();
      sendJson(res, 200, payload());
    } catch (err) {
      next(err);
    }
  });

  app.put("/api/admin-access", requirePin, async (req, res, next) => {
    try {
      const current = currentConfig().admin || {};
      await localStore.update({
        admin: {
          internet: req.body?.internet === undefined ? current.internet !== false : req.body.internet !== false,
          longPin: req.body?.longPin === undefined ? current.longPin !== false : req.body.longPin !== false,
        },
      });
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

  app.delete("/api/guest-photos/:id", requirePin, async (req, res, next) => {
    try {
      const result = await album.deletePhoto(req.params.id);
      broadcast();
      sendJson(res, 200, result);
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

  app.get("/media/guest/:file", (req, res, next) => {
    requireGuest(req, res, () => serveGuestPhoto(req, res, next));
  });

  function serveGuestPhoto(req, res) {
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
  }

  app.get("/media/starter/:id", lanRequired, (req, res) => {
    const item = catalogItems.find((entry) => entry.id === req.params.id);
    const filePath = item ? starterFile(mediaRoot, item) : null;
    if (!filePath) return res.status(404).send("Not downloaded");
    sendByteRange(req, res, filePath);
  });

  app.get("/media/cache/:id", lanRequired, (req, res) => {
    const id = String(req.params.id || "");
    if (!/^[a-z0-9-]{3,80}$/.test(id)) return res.status(404).send("Not found");
    const filePath = clips.fileFor(id);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("Not cached");
    sendByteRange(req, res, filePath);
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

  app.get(["/", "/app"], (req, res) => {
    const gate = guestGate(req);
    if (gate === "set") {
      setGuestCookie(req, res);
      const url = new URL(req.originalUrl, "http://pinball.local");
      url.searchParams.delete("k");
      const search = url.searchParams.toString();
      return res.redirect(302, `${url.pathname}${search ? `?${search}` : ""}`);
    }
    if (gate === false) return res.status(403).type("html").send(scanPage());
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
  refreshPublicAccess().catch((err) => console.error(err));

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

  let rotationSignature = "";
  const rotationTimer = setInterval(() => {
    try {
      const plan = payload().rotationPlan;
      const signature = JSON.stringify(plan);
      if (signature === rotationSignature) return;
      rotationSignature = signature;
      broadcast();
    } catch (err) {
      console.error(err);
    }
  }, 200);
  if (typeof rotationTimer.unref === "function") rotationTimer.unref();

  function attachWebSocket(server) {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket, req) => {
      socket.trusted = clientTrusted(req);
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
