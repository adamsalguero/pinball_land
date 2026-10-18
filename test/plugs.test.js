const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PlugService, isOpen, parseClock, LOGIN_NOTICE, sanitizePlugLog } = require("../src/plugs");
const { plugAuthError, plugDownError, PLUG_DOWN_MESSAGE } = require("../src/klap");

function fakeDevice({ host, alias, model, deviceId, on }) {
  return {
    host,
    alias,
    model,
    deviceId,
    on,
    async getSysInfo() {
      return { alias, model, deviceId };
    },
    async getPowerState() {
      return this.on;
    },
    async setPowerState(value) {
      this.on = Boolean(value);
      return true;
    },
  };
}

function harness(devices, start = new Date(2026, 9, 13, 9, 0, 0)) {
  let now = start;
  const memory = { plugs: {} };
  const client = {
    devices,
    async discover() {
      return this.devices;
    },
    async getDevice(host) {
      const device = this.devices.find((item) => item.host === host);
      if (!device) throw new Error(`no device ${host}`);
      return device;
    },
  };
  const service = new PlugService({
    client,
    now: () => now,
    getConfig: () => memory,
    updateConfig: async (patch) => {
      memory.plugs = patch.plugs;
    },
  });
  return {
    service,
    memory,
    setNow(date) {
      now = date;
    },
  };
}

test("clock windows include overnight close", () => {
  assert.equal(parseClock("7:05"), "07:05");
  assert.equal(parseClock("24:00"), null);
  const morning = new Date(2026, 9, 13, 11, 0, 0);
  const night = new Date(2026, 9, 13, 23, 30, 0);
  const afterClose = new Date(2026, 9, 14, 3, 0, 0);
  assert.equal(isOpen(morning, "10:00", "22:00"), true);
  assert.equal(isOpen(night, "10:00", "22:00"), false);
  assert.equal(isOpen(night, "22:00", "02:00"), true);
  assert.equal(isOpen(afterClose, "22:00", "02:00"), false);
});

test("discover, assign, and switch mocked Kasa plugs", async () => {
  const left = fakeDevice({ host: "192.168.1.31", alias: "Left TV", model: "HS103", deviceId: "plug-left", on: false });
  const right = fakeDevice({ host: "192.168.1.32", alias: "Right TV", model: "KP115", deviceId: "plug-right", on: true });
  const { service } = harness([left, right]);
  const found = await service.discover();
  assert.equal(found.devices.length, 2);
  assert.equal(found.devices[0].name, "Left TV");
  assert.equal(found.devices[0].on, false);

  await service.assign({ 1: "plug-left", 3: "plug-right" });
  await assert.rejects(() => service.assign({ 2: "plug-left" }), /only run one screen/);
  const on = await service.setSlotPower("1", true);
  assert.equal(left.on, true);
  assert.equal(on.devices.find((device) => device.id === "plug-left").on, true);
  await service.setAll(false);
  assert.equal(left.on, false);
  assert.equal(right.on, false);
  await assert.rejects(() => service.setSlotPower("2", true), /No plug is assigned/);
});

test("schedule turns assigned plugs on at open and off at close", async () => {
  const tv = fakeDevice({ host: "192.168.1.40", alias: "Center", model: "HS103", deviceId: "plug-center", on: false });
  const { service, setNow } = harness([tv], new Date(2026, 9, 13, 9, 0, 0));
  await service.discover();
  await service.assign({ 2: "plug-center" });
  await service.setSchedule({ enabled: true, onTime: "10:00", offTime: "22:00" });
  await service.tick();
  assert.equal(tv.on, false);
  setNow(new Date(2026, 9, 13, 10, 5, 0));
  await service.tick();
  assert.equal(tv.on, true);
  await service.tick();
  assert.equal(tv.on, true);
  setNow(new Date(2026, 9, 13, 22, 0, 0));
  await service.tick();
  assert.equal(tv.on, false);
});

test("TP-Link login stays on the server and a KLAP plug can be added by IP", async () => {
  const { service } = harness([]);
  service.client.probe = async (host, account) => {
    if (account.password !== "venue-secret") throw plugAuthError();
    return {
      id: "8006-hs103",
      name: "Adam TV",
      host,
      model: "HS103",
      mac: "ACA7F1D940DC",
      protocol: "klap",
      needsLogin: false,
      on: false,
    };
  };
  const saved = await service.setAccount({ username: "adam@example.com", password: "venue-secret" });
  assert.equal(saved.account.configured, true);
  assert.equal(saved.account.username, "a•••@example.com");
  assert.equal(JSON.stringify(saved).includes("venue-secret"), false);
  assert.equal(JSON.stringify(service.config()).includes("venue-secret"), true);
  const added = await service.addHost("192.168.1.159");
  assert.equal(added.devices[0].name, "Adam TV");
  assert.equal(added.devices[0].protocol, "klap");
  assert.equal(added.notice, "");
  await service.setAccount({ clear: true });
  service.client.probe = async () => {
    throw plugAuthError();
  };
  const needs = await service.addHost("192.168.1.160");
  assert.equal(needs.notice, LOGIN_NOTICE);
  assert.equal(needs.devices.some((device) => device.needsLogin), true);
  assert.equal(JSON.stringify(needs).includes("stack"), false);
  await assert.rejects(() => service.addHost("not-an-ip"), /IPv4 address/);
});

test("a transport error clears the login prompt and the log keeps the password out", async () => {
  const lines = [];
  const memory = {
    plugs: {
      devices: [{ id: "8006", name: "Adam TV", host: "192.168.1.159", protocol: "klap", needsLogin: true }],
      assignments: { 1: "8006", 2: null, 3: null },
    },
  };
  const service = new PlugService({
    client: {
      klap() {
        return {
          async setPowerState() {
            throw plugDownError();
          },
        };
      },
    },
    getConfig: () => memory,
    updateConfig: async (patch) => {
      memory.plugs = patch.plugs;
    },
    log: (line) => lines.push(line),
  });
  await assert.rejects(() => service.setSlotPower("1", true), (err) => {
    assert.equal(err.code, "plug-down");
    assert.equal(err.message, PLUG_DOWN_MESSAGE);
    return true;
  });
  assert.equal(service.publicState().notice, "");
  assert.equal(service.publicState().devices[0].needsLogin, false);
  service.client.klap = () => ({
    async setPowerState() {
      throw plugAuthError();
    },
  });
  await assert.rejects(() => service.setSlotPower("1", false), (err) => {
    assert.equal(err.code, "plug-auth");
    return true;
  });
  assert.equal(service.publicState().notice, LOGIN_NOTICE);
  assert.equal(service.publicState().devices[0].needsLogin, true);
  await service.setAccount({ username: "adam@example.com", password: "venue-secret" });
  const text = lines.join("\n");
  assert.match(text, /power host=192\.168\.1\.159 on=true fail code=plug-down/);
  assert.match(text, /power host=192\.168\.1\.159 on=false fail code=plug-auth/);
  assert.match(text, /account saved/);
  assert.equal(text.includes("venue-secret"), false);
  assert.equal(sanitizePlugLog("cookie=TP_SESSIONID=ship-session password=venue-secret"), "");
});
