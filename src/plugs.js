const SLOT_IDS = ["1", "2", "3"];

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clockToMinutes(clock) {
  const [hour, minute] = String(clock).split(":").map(Number);
  return hour * 60 + minute;
}

function isOpen(date, onTime, offTime) {
  const now = date.getHours() * 60 + date.getMinutes();
  const on = clockToMinutes(onTime);
  const off = clockToMinutes(offTime);
  if (on === off) return false;
  if (on < off) return now >= on && now < off;
  return now >= on || now < off;
}

function normalizeDevice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const host = String(raw.host || "").trim();
  const id = String(raw.id || host).trim();
  if (!id || !host) return null;
  return {
    id,
    name: String(raw.name || raw.alias || host).trim() || host,
    host,
    model: String(raw.model || "").trim(),
  };
}

function normalizePlugs(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const assignments = { 1: null, 2: null, 3: null };
  const source = incoming.assignments && typeof incoming.assignments === "object" ? incoming.assignments : {};
  for (const slot of SLOT_IDS) {
    const value = source[slot];
    assignments[slot] = value ? String(value) : null;
  }
  const devices = [];
  const seen = new Set();
  for (const item of Array.isArray(incoming.devices) ? incoming.devices : []) {
    const device = normalizeDevice(item);
    if (!device || seen.has(device.id)) continue;
    seen.add(device.id);
    devices.push(device);
  }
  const scheduleIn = incoming.schedule && typeof incoming.schedule === "object" ? incoming.schedule : {};
  return {
    assignments,
    devices,
    schedule: {
      enabled: Boolean(scheduleIn.enabled),
      onTime: parseClock(scheduleIn.onTime) || "10:00",
      offTime: parseClock(scheduleIn.offTime) || "22:00",
    },
  };
}

function createTplinkClient({ Client, timeoutMs = 4000 } = {}) {
  let Impl = Client;
  if (!Impl) {
    try {
      ({ Client: Impl } = require("tplink-smarthome-api"));
    } catch {
      return null;
    }
  }
  const client = new Impl();
  return {
    async discover() {
      const found = new Map();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, timeoutMs);
        const onDevice = (device) => {
          if (device?.host) found.set(device.host, device);
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        function cleanup() {
          clearTimeout(timer);
          client.removeListener("plug-new", onDevice);
          client.removeListener("device-new", onDevice);
          client.removeListener("error", onError);
          try {
            client.stopDiscovery();
          } catch {
            // discovery already stopped
          }
        }
        client.on("plug-new", onDevice);
        client.on("device-new", onDevice);
        client.on("error", onError);
        client.startDiscovery({
          deviceTypes: ["plug"],
          discoveryTimeout: timeoutMs,
          discoveryInterval: 2000,
        });
      });
      return [...found.values()];
    },
    getDevice(host) {
      return client.getDevice({ host });
    },
  };
}

class PlugService {
  constructor({ client = null, now = () => new Date(), getConfig, updateConfig } = {}) {
    if (typeof getConfig !== "function" || typeof updateConfig !== "function") {
      throw new Error("PlugService needs getConfig and updateConfig");
    }
    this.client = client;
    this.now = now;
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.power = new Map();
    this.lastApplied = null;
  }

  config() {
    return normalizePlugs(this.getConfig().plugs);
  }

  async remember(patch) {
    const current = this.config();
    const next = normalizePlugs({
      ...current,
      ...patch,
      assignments: { ...current.assignments, ...(patch.assignments || {}) },
      schedule: { ...current.schedule, ...(patch.schedule || {}) },
      devices: patch.devices === undefined ? current.devices : patch.devices,
    });
    await this.updateConfig({ plugs: next });
    return this.config();
  }

  describe(device) {
    return {
      ...device,
      on: this.power.has(device.id) ? this.power.get(device.id) : null,
    };
  }

  publicState() {
    const config = this.config();
    return {
      assignments: config.assignments,
      devices: config.devices.map((device) => this.describe(device)),
      schedule: config.schedule,
    };
  }

  deviceById(id) {
    return this.config().devices.find((device) => device.id === String(id)) || null;
  }

  assignedIds() {
    const { assignments } = this.config();
    return [...new Set(SLOT_IDS.map((slot) => assignments[slot]).filter(Boolean))];
  }

  async liveDevice(device) {
    if (!this.client) {
      throw Object.assign(new Error("tplink-smarthome-api is not available"), { status: 500 });
    }
    return this.client.getDevice(device.host);
  }

  async discover() {
    if (!this.client) {
      throw Object.assign(new Error("tplink-smarthome-api is not available"), { status: 500 });
    }
    const found = await this.client.discover();
    const devices = [];
    for (const device of found || []) {
      const info = typeof device.getSysInfo === "function" ? await device.getSysInfo().catch(() => ({})) : {};
      const host = String(device.host || info.host || "").trim();
      const normalized = normalizeDevice({
        id: info.deviceId || device.deviceId || host,
        name: info.alias || device.alias || host,
        host,
        model: info.model || device.model || "",
      });
      if (normalized) devices.push(normalized);
      if (typeof device.getPowerState === "function" && normalized) {
        const on = await device.getPowerState().catch(() => null);
        if (typeof on === "boolean") this.power.set(normalized.id, on);
      }
    }
    await this.remember({ devices });
    return this.publicState();
  }

  async assign(assignments) {
    const incoming = assignments && typeof assignments === "object" ? assignments : {};
    const next = { ...this.config().assignments };
    const used = new Set();
    for (const slot of SLOT_IDS) {
      if (incoming[slot] === undefined) continue;
      if (incoming[slot] === null || incoming[slot] === "") {
        next[slot] = null;
        continue;
      }
      const id = String(incoming[slot]);
      if (!this.deviceById(id)) {
        throw Object.assign(new Error("Pick a plug from the discovered list"), { status: 400 });
      }
      if (used.has(id) || Object.entries(next).some(([other, value]) => other !== slot && value === id)) {
        throw Object.assign(new Error("Each plug can only run one screen"), { status: 400 });
      }
      used.add(id);
      next[slot] = id;
    }
    await this.remember({ assignments: next });
    return this.publicState();
  }

  async setSchedule(patch) {
    const current = this.config().schedule;
    const enabled = patch.enabled === undefined ? current.enabled : Boolean(patch.enabled);
    const onTime = patch.onTime === undefined ? current.onTime : parseClock(patch.onTime);
    const offTime = patch.offTime === undefined ? current.offTime : parseClock(patch.offTime);
    if (!onTime || !offTime) {
      throw Object.assign(new Error("Use times like 10:00 and 22:00"), { status: 400 });
    }
    await this.remember({ schedule: { enabled, onTime, offTime } });
    this.lastApplied = null;
    return this.publicState();
  }

  async setDevicePower(id, on) {
    const device = this.deviceById(id);
    if (!device) throw Object.assign(new Error("Unknown plug"), { status: 404 });
    const live = await this.liveDevice(device);
    await live.setPowerState(Boolean(on));
    this.power.set(device.id, Boolean(on));
    return Boolean(on);
  }

  async setSlotPower(slot, on) {
    const id = this.config().assignments[String(slot)];
    if (!id) {
      throw Object.assign(new Error(`No plug is assigned to display ${slot}. Never put the PC on a plug.`), { status: 400 });
    }
    await this.setDevicePower(id, on);
    return this.publicState();
  }

  async setAll(on) {
    const ids = this.assignedIds();
    if (!ids.length) {
      throw Object.assign(new Error("Assign a plug to a screen first. Never put the PC on a plug."), { status: 400 });
    }
    const errors = [];
    for (const id of ids) {
      try {
        await this.setDevicePower(id, on);
      } catch (err) {
        errors.push(err.message || String(err));
      }
    }
    if (errors.length === ids.length) {
      throw Object.assign(new Error(errors[0] || "Could not reach the plugs"), { status: 502 });
    }
    return this.publicState();
  }

  async refresh() {
    for (const id of this.assignedIds()) {
      const device = this.deviceById(id);
      if (!device || !this.client) continue;
      try {
        const live = await this.liveDevice(device);
        if (typeof live.getPowerState === "function") {
          this.power.set(id, Boolean(await live.getPowerState()));
        }
      } catch {
        // leave the last known state
      }
    }
    return this.publicState();
  }

  async tick() {
    await this.refresh();
    const schedule = this.config().schedule;
    if (!schedule.enabled) {
      this.lastApplied = null;
      return this.publicState();
    }
    if (!this.assignedIds().length) return this.publicState();
    const desired = isOpen(this.now(), schedule.onTime, schedule.offTime) ? "on" : "off";
    if (this.lastApplied !== desired) {
      await this.setAll(desired === "on");
      this.lastApplied = desired;
    }
    return this.publicState();
  }
}

module.exports = {
  SLOT_IDS,
  parseClock,
  isOpen,
  normalizePlugs,
  createTplinkClient,
  PlugService,
};
