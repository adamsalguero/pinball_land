const { createKlapDevice, plugAuthError, sanitizePlugLog } = require("./klap");
const {
  collectDiscoveryReplies,
  createDiscoveryKeypair,
  formatMac,
  isIpv4,
  macKey,
  mergeByMac,
} = require("./plug-discovery");

const SLOT_IDS = ["1", "2", "3"];
const LOGIN_NOTICE = "A plug answered, but it needs the TP-Link email and password from the Kasa app. Enter them below, then find the plugs again.";

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

function maskUsername(email) {
  const value = String(email || "").trim();
  const at = value.indexOf("@");
  if (!value) return "";
  if (at <= 1) return "••••";
  return `${value[0]}•••${value.slice(at)}`;
}

function normalizeAccount(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  return {
    username: String(incoming.username || "").trim(),
    password: String(incoming.password || ""),
  };
}

function normalizeDevice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const host = String(raw.host || "").trim();
  const id = String(raw.id || host).trim();
  if (!id || !host) return null;
  const protocol = raw.protocol === "klap" || raw.protocol === "legacy" ? raw.protocol : "auto";
  return {
    id,
    name: String(raw.name || raw.alias || host).trim() || host,
    host,
    model: String(raw.model || "").trim(),
    mac: formatMac(raw.mac),
    protocol,
    needsLogin: Boolean(raw.needsLogin),
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
  const manualHosts = [];
  const seenHosts = new Set();
  for (const host of Array.isArray(incoming.manualHosts) ? incoming.manualHosts : []) {
    const ip = String(host || "").trim();
    if (!isIpv4(ip) || seenHosts.has(ip)) continue;
    seenHosts.add(ip);
    manualHosts.push(ip);
  }
  return {
    assignments,
    devices,
    manualHosts,
    account: normalizeAccount(incoming.account),
    schedule: {
      enabled: Boolean(scheduleIn.enabled),
      onTime: parseClock(scheduleIn.onTime) || "10:00",
      offTime: parseClock(scheduleIn.offTime) || "22:00",
    },
  };
}

function createMockPlugClient() {
  const power = new Map();
  const device = {
    host: "10.0.0.50",
    alias: "Screen 1",
    model: "HS103",
    async getSysInfo() {
      return { deviceId: "mock-1", alias: "Screen 1", model: "HS103", host: "10.0.0.50" };
    },
    async getPowerState() {
      return Boolean(power.get("mock-1"));
    },
    async setPowerState(on) {
      power.set("mock-1", Boolean(on));
    },
  };
  return {
    async discover() {
      return [device];
    },
    getDevice() {
      return device;
    },
  };
}

function deviceFromInfo(info, host, protocol) {
  return normalizeDevice({
    id: info.deviceId || info.device_id || macKey(info.mac) || host,
    name: info.alias || info.device_name || host,
    host: info.ip || host,
    model: info.model || info.device_model || "",
    mac: info.mac,
    protocol,
    needsLogin: false,
  });
}

function createPlugClient({ timeoutMs = 3000, interfaces, request, log = () => {} } = {}) {
  const legacy = createTplinkClient({ timeoutMs });
  const klapSlots = new Map();
  function klap(host, account) {
    if (!klapSlots.has(host)) {
      klapSlots.set(host, { session: null, chain: Promise.resolve(), accountKey: "" });
    }
    return createKlapDevice(host, account, request, { slot: klapSlots.get(host), log });
  }
  return {
    legacy,
    async discover(account) {
      const { publicKey, privateKey } = createDiscoveryKeypair();
      let found = [];
      try {
        found = await collectDiscoveryReplies({
          interfaces,
          timeoutMs,
          privateKey,
          publicPem: publicKey,
        });
      } catch {
        found = [];
      }
      const named = [];
      for (const device of found) {
        if (device.protocol !== "klap") {
          named.push(device);
          continue;
        }
        try {
          const live = klap(device.host, account);
          const info = await live.getSysInfo();
          const normalized = deviceFromInfo(info, device.host, "klap");
          if (normalized) named.push({ ...device, ...normalized, protocol: "klap", needsLogin: false });
        } catch (err) {
          log(`discover host=${device.host} fail code=${err.code || "error"}`);
          named.push({
            ...device,
            protocol: "klap",
            needsLogin: err.code === "plug-auth",
            name: device.name || "Kasa plug",
          });
        }
      }
      return mergeByMac(named);
    },
    async probe(host, account) {
      try {
        const live = klap(host, account);
        const info = await live.getSysInfo();
        const device = deviceFromInfo(info, host, "klap");
        if (device) return { ...device, on: Number(info.relay_state) === 1 };
      } catch (err) {
        if (err.code === "plug-auth") throw err;
      }
      if (!legacy) throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
      let info;
      try {
        const live = legacy.getDevice(host);
        info = await live.getSysInfo();
      } catch (err) {
        if (err.code === "plug-auth" || err.code === "plug-down") throw err;
        throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
      }
      const device = deviceFromInfo(info || {}, host, "legacy");
      if (!device) throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
      return device;
    },
    getDevice(host) {
      if (!legacy) throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
      return legacy.getDevice(host);
    },
    klap,
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
  constructor({ client = null, now = () => new Date(), getConfig, updateConfig, log = () => {} } = {}) {
    if (typeof getConfig !== "function" || typeof updateConfig !== "function") {
      throw new Error("PlugService needs getConfig and updateConfig");
    }
    this.client = client;
    this.now = now;
    this.getConfig = getConfig;
    this.updateConfig = updateConfig;
    this.log = typeof log === "function" ? log : () => {};
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
      account: patch.account === undefined ? current.account : patch.account,
      manualHosts: patch.manualHosts === undefined ? current.manualHosts : patch.manualHosts,
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
    const devices = config.devices.map((device) => this.describe(device));
    const needsLogin = devices.some((device) => device.needsLogin);
    return {
      assignments: config.assignments,
      devices,
      schedule: config.schedule,
      manualHosts: config.manualHosts,
      account: {
        username: maskUsername(config.account.username),
        configured: Boolean(config.account.username && config.account.password),
      },
      notice: needsLogin ? LOGIN_NOTICE : "",
    };
  }

  deviceById(id) {
    return this.config().devices.find((device) => device.id === String(id)) || null;
  }

  assignedIds() {
    const { assignments } = this.config();
    return [...new Set(SLOT_IDS.map((slot) => assignments[slot]).filter(Boolean))];
  }

  account() {
    return this.config().account;
  }

  async liveDevice(device) {
    if (!this.client) {
      throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
    }
    if (device.protocol !== "legacy" && typeof this.client.klap === "function") {
      return this.client.klap(device.host, this.account());
    }
    if (device.protocol === "auto" && typeof this.client.klap === "function") {
      return this.client.klap(device.host, this.account());
    }
    return this.client.getDevice(device.host);
  }

  async withDevice(device, run) {
    if (device.protocol === "legacy" || typeof this.client.klap !== "function") {
      const live = await this.liveDevice(device);
      return run(live);
    }
    try {
      const live = this.client.klap(device.host, this.account());
      return await run(live);
    } catch (err) {
      if (err.code === "plug-auth" || device.protocol === "klap") throw err;
      const live = await this.client.getDevice(device.host);
      return run(live);
    }
  }

  async markLogin(id, needsLogin) {
    const devices = this.config().devices.map((device) => (
      device.id === id ? { ...device, needsLogin } : device
    ));
    await this.remember({ devices });
  }

  async discover() {
    if (!this.client) {
      throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
    }
    const found = await this.client.discover(this.account());
    const devices = [];
    for (const device of found || []) {
      const info = typeof device.getSysInfo === "function" ? await device.getSysInfo().catch(() => ({})) : {};
      const host = String(device.host || info.ip || info.host || "").trim();
      const normalized = normalizeDevice({
        id: info.deviceId || info.device_id || device.deviceId || device.id || macKey(info.mac || device.mac) || host,
        name: info.alias || info.device_name || device.alias || device.name || host,
        host,
        model: info.model || info.device_model || device.model || "",
        mac: info.mac || device.mac,
        protocol: device.protocol,
        needsLogin: Boolean(device.needsLogin),
      });
      if (normalized) devices.push(normalized);
      if (typeof device.on === "boolean" && normalized) this.power.set(normalized.id, device.on);
      if (normalized) this.log(`discover host=${normalized.host} protocol=${normalized.protocol} needsLogin=${normalized.needsLogin}`);
      if (typeof device.getPowerState === "function" && normalized && !device.needsLogin) {
        const on = await device.getPowerState().catch(() => null);
        if (typeof on === "boolean") this.power.set(normalized.id, on);
      }
    }
    for (const host of this.config().manualHosts) {
      if (devices.some((device) => device.host === host)) continue;
      try {
        const probed = await this.probeHost(host);
        if (probed) devices.push(probed);
      } catch (err) {
        if (err.code !== "plug-auth") continue;
        devices.push(normalizeDevice({
          id: host,
          name: "Kasa plug",
          host,
          protocol: "klap",
          needsLogin: true,
        }));
      }
    }
    await this.remember({ devices: mergeByMac(devices) });
    this.log(`discover count=${this.config().devices.length}`);
    return this.publicState();
  }

  async probeHost(host) {
    if (typeof this.client.probe !== "function") return null;
    const found = await this.client.probe(host, this.account());
    const device = normalizeDevice(found);
    if (device && typeof found.on === "boolean") this.power.set(device.id, found.on);
    return device;
  }

  async addHost(host) {
    const ip = String(host || "").trim();
    if (!isIpv4(ip)) {
      throw Object.assign(new Error("Enter an IPv4 address like 192.168.1.159."), { status: 400 });
    }
    const manualHosts = [...new Set([...this.config().manualHosts, ip])];
    let found = null;
    try {
      found = await this.probeHost(ip);
    } catch (err) {
      this.log(`add host=${ip} fail code=${err.code || "error"}`);
      if (err.code !== "plug-auth") throw err;
      found = normalizeDevice({ id: ip, name: "Kasa plug", host: ip, protocol: "klap", needsLogin: true });
    }
    if (!found) {
      throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
    }
    const devices = mergeByMac([
      ...this.config().devices.filter((device) => device.host !== ip && macKey(device.mac) !== macKey(found.mac)),
      found,
    ]);
    await this.remember({ manualHosts, devices });
    this.log(`add host=${ip} protocol=${found.protocol} needsLogin=${Boolean(found.needsLogin)}`);
    return this.publicState();
  }

  async setAccount(patch = {}) {
    const current = this.account();
    if (patch.clear) {
      await this.remember({ account: { username: "", password: "" } });
      this.log("account cleared");
      return this.publicState();
    }
    const typedUser = patch.username === undefined || patch.username === null ? "" : String(patch.username).trim();
    const typedPass = patch.password === undefined || patch.password === null ? "" : String(patch.password);
    if (!typedUser && !typedPass) return this.publicState();
    const username = typedUser || current.username;
    const password = typedPass || (username === current.username ? current.password : "");
    if (username && !password) {
      throw Object.assign(new Error("Enter the Kasa app password with that email."), { status: 400 });
    }
    await this.remember({ account: { username, password } });
    this.log("account saved");
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
    try {
      await this.withDevice(device, (live) => live.setPowerState(Boolean(on)));
    } catch (err) {
      const code = err.code === "plug-auth" ? "plug-auth" : "plug-down";
      this.log(`power host=${device.host} on=${Boolean(on)} fail code=${code}`);
      if (err.code === "plug-auth") {
        if (!device.needsLogin) await this.markLogin(device.id, true);
        throw plugAuthError();
      }
      if (device.needsLogin) await this.markLogin(device.id, false);
      if (err.code === "plug-down" || err.status === 404 || err.status === 400) throw err;
      throw Object.assign(new Error("The plug did not answer."), { status: 502, code: "plug-down" });
    }
    this.log(`power host=${device.host} on=${Boolean(on)} ok`);
    if (device.needsLogin) await this.markLogin(device.id, false);
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
        const on = await this.withDevice(device, (live) => live.getPowerState());
        if (typeof on === "boolean") {
          this.power.set(id, on);
          if (device.needsLogin) await this.markLogin(id, false);
        }
      } catch (err) {
        if (err.code === "plug-auth") {
          if (!device.needsLogin) await this.markLogin(id, true);
          this.log(`refresh host=${device.host} fail code=plug-auth`);
        } else if (device.needsLogin) {
          await this.markLogin(id, false);
          this.log(`refresh host=${device.host} fail code=${err.code || "plug-down"}`);
        }
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
  maskUsername,
  createTplinkClient,
  createPlugClient,
  createMockPlugClient,
  PlugService,
  LOGIN_NOTICE,
  sanitizePlugLog,
};
