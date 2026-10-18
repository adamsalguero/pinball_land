const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { normalizeDisplays } = require("./displays");
const { normalizePlugs } = require("./plugs");
const { normalizeYoutubeLists } = require("./youtube");
const { pinIsValid, DEFAULT_PIN } = require("./devices");
const { BUILTIN_OPDB_API_KEY } = require("./opdb");

const DEFAULTS = {
  port: 3000,
  pin: DEFAULT_PIN,
  opdbApiKey: BUILTIN_OPDB_API_KEY,
  httpsPort: 3443,
};

function clampIdle(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 10;
  return Math.min(180, Math.max(1, n));
}

function readConfigFile(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function parsePort(value, fallback, label, { allowZero = false } = {}) {
  const source = value === undefined || value === null || value === "" ? fallback : value;
  const port = Number.parseInt(source, 10);
  if (allowZero && port === 0) return 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${source}`);
  }
  return port;
}

function normalizeAirplay(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const args = Array.isArray(incoming.args) ? incoming.args.map((item) => String(item)).filter(Boolean) : [];
  const { normalizeAirplayTarget } = require("./airplay");
  return {
    command: String(incoming.command || "").trim(),
    args,
    windowTitle: String(incoming.windowTitle || "Pinball Land").trim() || "Pinball Land",
    target: normalizeAirplayTarget(incoming.target),
  };
}

function normalizeMediaSettings(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const disabledIds = Array.isArray(incoming.disabledIds)
    ? [...new Set(incoming.disabledIds.map((item) => String(item)).filter((id) => /^[a-z0-9:-]{3,100}$/.test(id)))].slice(0, 200)
    : [];
  return {
    allAges: incoming.allAges !== false,
    disabledIds,
  };
}

function normalizeMotion() {
  return "subtle";
}

function httpBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return "";
    return url.toString().replace(/\/$/, "").slice(0, 200);
  } catch {
    return "";
  }
}

const LEGACY_SLOGANS = {
  halloween: "Happy Halloween",
  christmas: "Merry Christmas",
};

function defaultSlogans() {
  return {
    pinnacle: "",
    halloween: "Happy Halloween!",
    christmas: "Merry Christmas!",
  };
}

function normalizeSlogans(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const slogans = defaultSlogans();
  if (!raw || typeof raw !== "object") return slogans;
  for (const key of Object.keys(slogans)) {
    if (incoming[key] === undefined) continue;
    const value = String(incoming[key] ?? "").trim().slice(0, 80);
    if (LEGACY_SLOGANS[key] && value === LEGACY_SLOGANS[key]) continue;
    slogans[key] = value;
  }
  return slogans;
}

function normalizePhotos(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const eventName = String(incoming.eventName || "Tonight").trim().slice(0, 60);
  return {
    autoApprove: incoming.autoApprove !== false,
    paused: incoming.paused === true,
    pinboard: incoming.pinboard !== false,
    publicBaseUrl: httpBaseUrl(incoming.publicBaseUrl),
    style: "pinboard",
    span: false,
    eventName: eventName || "Tonight",
  };
}

function normalizePublicAccess(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: incoming.enabled === true,
    cloudflare: incoming.cloudflare === true,
  };
}

function normalizeAdminAccess(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  return {
    internet: incoming.internet !== false,
    longPin: incoming.longPin !== false,
  };
}

function normalizeClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeUpdates(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const interval = Number.parseInt(incoming.intervalMin, 10);
  return {
    enabled: incoming.enabled !== false,
    intervalMin: Number.isFinite(interval) ? Math.min(1440, Math.max(5, interval)) : 30,
    channel: incoming.channel === "preview" ? "preview" : "stable",
    branch: String(incoming.branch || "main").trim() || "main",
    repo: /^[\w.-]+\/[\w.-]+$/.test(String(incoming.repo || "").trim())
      ? String(incoming.repo).trim()
      : "adamsalguero/pinball_land",
    quietStart: String(incoming.quietStart || "02:00"),
    quietEnd: String(incoming.quietEnd || "06:00"),
    nightlyAt: normalizeClock(incoming.nightlyAt, "03:17"),
  };
}

function normalizePresentation(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  return {
    idleMinutes: clampIdle(incoming.idleMinutes ?? 10),
  };
}

function loadConfig(configPath = path.join(__dirname, "..", "config.json")) {
  const fileConfig = readConfigFile(configPath);
  const port = parsePort(process.env.PORT || fileConfig.port, DEFAULTS.port, "port");
  const httpsPort = parsePort(process.env.HTTPS_PORT ?? fileConfig.httpsPort, DEFAULTS.httpsPort, "httpsPort", {
    allowZero: true,
  });
  const pin = String(process.env.CONTROL_PIN || fileConfig.pin || DEFAULTS.pin);
  const opdbApiKey = String(process.env.OPDB_API_KEY || fileConfig.opdbApiKey || DEFAULTS.opdbApiKey);

  if (!pin) {
    throw new Error("Control PIN cannot be empty. Set it in config.json or CONTROL_PIN.");
  }

  return {
    port,
    httpsPort,
    pin,
    opdbApiKey,
    displays: normalizeDisplays(fileConfig.displays),
    presentation: normalizePresentation(fileConfig.presentation),
    airplay: normalizeAirplay(fileConfig.airplay),
    plugs: normalizePlugs(fileConfig.plugs),
    media: normalizeMediaSettings(fileConfig.media),
    motion: normalizeMotion(fileConfig.motion),
    photos: normalizePhotos(fileConfig.photos),
    publicAccess: normalizePublicAccess(fileConfig.publicAccess),
    admin: normalizeAdminAccess(fileConfig.admin),
    guestSecret: typeof fileConfig.guestSecret === "string" && fileConfig.guestSecret.length >= 16 ? fileConfig.guestSecret : "",
    slogans: normalizeSlogans(fileConfig.slogans),
    youtube: normalizeYoutubeLists(fileConfig.youtube),
    updates: normalizeUpdates(fileConfig.updates),
  };
}

function mergeScreens(currentRaw, patchDisplays) {
  const current = normalizeDisplays(currentRaw);
  const screens = {
    1: { ...current.screens["1"] },
    2: { ...current.screens["2"] },
    3: { ...current.screens["3"] },
  };
  const incoming = patchDisplays?.screens;
  if (incoming && typeof incoming === "object") {
    for (const slot of ["1", "2", "3"]) {
      if (incoming[slot] && typeof incoming[slot] === "object") {
        screens[slot] = { ...screens[slot], ...incoming[slot] };
      }
    }
  }
  return screens;
}

async function writeConfigFile(configPath, data) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, configPath);
}

function ensureGuestSecret(configPath) {
  const raw = readConfigFile(configPath);
  if (typeof raw.guestSecret === "string" && raw.guestSecret.length >= 16) return raw.guestSecret;
  raw.guestSecret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
  return raw.guestSecret;
}

function writeDefaultPin(configPath) {
  const raw = readConfigFile(configPath);
  raw.pin = DEFAULT_PIN;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
  return configPath;
}

function createConfigStore(configPath) {
  return {
    path: configPath,
    get() {
      return loadConfig(configPath);
    },
    async update(patch = {}) {
      const raw = readConfigFile(configPath);
      if (patch.displays) {
        const merged = {
          ...normalizeDisplays(raw.displays),
          ...patch.displays,
          screens: mergeScreens(raw.displays, patch.displays),
        };
        raw.displays = normalizeDisplays(merged);
      }
      if (patch.presentation) {
        raw.presentation = normalizePresentation({
          ...normalizePresentation(raw.presentation),
          ...patch.presentation,
        });
      }
      if (patch.airplay) {
        raw.airplay = normalizeAirplay({
          ...normalizeAirplay(raw.airplay),
          ...patch.airplay,
        });
      }
      if (patch.plugs) {
        raw.plugs = normalizePlugs(patch.plugs);
      } else if (!raw.plugs) {
        raw.plugs = normalizePlugs(null);
      }
      if (patch.media) {
        raw.media = normalizeMediaSettings({
          ...normalizeMediaSettings(raw.media),
          ...patch.media,
        });
      } else if (!raw.media) {
        raw.media = normalizeMediaSettings(null);
      }
      if (patch.motion !== undefined) raw.motion = normalizeMotion(patch.motion);
      if (patch.photos) {
        raw.photos = normalizePhotos({ ...normalizePhotos(raw.photos), ...patch.photos });
      }
      if (patch.publicAccess) {
        raw.publicAccess = normalizePublicAccess({ ...normalizePublicAccess(raw.publicAccess), ...patch.publicAccess });
      }
      if (patch.admin) {
        raw.admin = normalizeAdminAccess({ ...normalizeAdminAccess(raw.admin), ...patch.admin });
      }
      if (patch.guestSecret !== undefined && typeof patch.guestSecret === "string" && patch.guestSecret.length >= 16) {
        raw.guestSecret = patch.guestSecret;
      }
      if (patch.slogans) {
        raw.slogans = normalizeSlogans({ ...normalizeSlogans(raw.slogans), ...patch.slogans });
      }
      if (patch.youtube) raw.youtube = normalizeYoutubeLists(patch.youtube);
      if (patch.updates) {
        raw.updates = normalizeUpdates({ ...normalizeUpdates(raw.updates), ...patch.updates });
      }
      if (patch.pin !== undefined) {
        if (!pinIsValid(patch.pin)) {
          throw Object.assign(new Error("PIN must be 4 to 12 digits"), { status: 400 });
        }
        raw.pin = String(patch.pin);
      }
      if (raw.port === undefined) raw.port = DEFAULTS.port;
      if (raw.pin === undefined) raw.pin = DEFAULTS.pin;
      if (raw.httpsPort === undefined) raw.httpsPort = DEFAULTS.httpsPort;
      await writeConfigFile(configPath, raw);
      return loadConfig(configPath);
    },
  };
}

module.exports = {
  loadConfig,
  createConfigStore,
  readConfigFile,
  writeDefaultPin,
  DEFAULTS,
  clampIdle,
  normalizeAirplay,
  normalizePresentation,
  normalizeMediaSettings,
  normalizeMotion,
  normalizePhotos,
  normalizePublicAccess,
  normalizeAdminAccess,
  ensureGuestSecret,
  normalizeSlogans,
  normalizeUpdates,
};
