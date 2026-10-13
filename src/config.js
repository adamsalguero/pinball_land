const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { normalizeDisplays } = require("./displays");

const DEFAULTS = {
  port: 3000,
  pin: "1234",
  opdbApiKey: "",
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
  return {
    command: String(incoming.command || "").trim(),
    args,
    windowTitle: String(incoming.windowTitle || "Pinball Land").trim() || "Pinball Land",
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
  DEFAULTS,
  clampIdle,
  normalizeAirplay,
  normalizePresentation,
};
