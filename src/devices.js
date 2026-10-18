const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const COOKIE_NAME = "pl_device";
const DEFAULT_PIN = "2224";
const DEVICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeen: device.lastSeen,
  };
}

class DeviceStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { joinToken: newToken(), devices: [] };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
      this.data = {
        joinToken: typeof parsed.joinToken === "string" && parsed.joinToken.length >= 16 ? parsed.joinToken : newToken(),
        devices: devices
          .filter((item) => item && item.id && item.tokenHash)
          .map((item) => ({
            id: String(item.id),
            name: String(item.name || "Admin iPad").slice(0, 40),
            tokenHash: String(item.tokenHash),
            createdAt: Number(item.createdAt) || Date.now(),
            lastSeen: Number(item.lastSeen) || Date.now(),
          })),
      };
    } catch (err) {
      if (err.code !== "ENOENT") console.error(err);
      this.data = { joinToken: newToken(), devices: [] };
    }
  }

  async save() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, this.filePath);
  }

  list() {
    return this.data.devices.map(publicDevice);
  }

  issue(name) {
    const token = newToken();
    const device = {
      id: crypto.randomUUID(),
      name: String(name || "Admin iPad").trim().slice(0, 40) || "Admin iPad",
      tokenHash: hashToken(token),
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.data.devices.push(device);
    return { token, device: publicDevice(device) };
  }

  find(token) {
    if (!token) return null;
    const hashed = hashToken(token);
    const device = this.data.devices.find((item) => safeEqual(item.tokenHash, hashed)) || null;
    if (!device) return null;
    if (Date.now() - device.createdAt > DEVICE_MAX_AGE_MS) {
      this.revoke(device.id);
      this.save().catch((err) => console.error(err));
      return null;
    }
    return device;
  }

  touch(id) {
    const device = this.data.devices.find((item) => item.id === id);
    if (!device) return;
    device.lastSeen = Date.now();
  }

  revoke(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((device) => device.id !== id);
    return this.data.devices.length !== before;
  }

  revokeAll() {
    this.data.devices = [];
    this.data.joinToken = newToken();
    return this.data.joinToken;
  }

  joinMatches(token) {
    return safeEqual(this.data.joinToken, String(token || ""));
  }
}

function pinIsValid(pin) {
  return /^\d{4,12}$/.test(String(pin || ""));
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_PIN,
  DEVICE_MAX_AGE_MS,
  DeviceStore,
  hashToken,
  pinIsValid,
  publicDevice,
};
