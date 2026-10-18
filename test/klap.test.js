const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const zlib = require("zlib");
const {
  authHashV1,
  authHashV2,
  handshake1Hash,
  handshake2Hash,
  KlapCipher,
  openKlapSession,
  createKlapDevice,
  PLUG_AUTH_MESSAGE,
  PLUG_DOWN_MESSAGE,
  DEFAULT_KASA_USERNAME,
  DEFAULT_KASA_PASSWORD,
} = require("../src/klap");
const {
  broadcastAddress,
  discoveryTargets,
  generateKlapDiscoveryQuery,
  createDiscoveryKeypair,
  legacyDiscoveryPacket,
  parseLegacyDiscovery,
  parseModernDiscovery,
  mergeByMac,
  xorEncrypt,
  macKey,
} = require("../src/plug-discovery");

const LOCAL = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const REMOTE = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");

test("KLAP v2 key, iv, and ciphertext match the python-kasa derivation", () => {
  const hash = authHashV2("foo", "bar");
  assert.equal(hash.toString("hex"), "fbafbfc0b0166ca060c19b4b429f8d51bdf90b61395ca5b14e127d1533c7b1a2");
  assert.equal(authHashV1("foo", "bar").toString("hex"), "0105fcbc9eea8193de8e1834677b6c6b");
  assert.equal(authHashV2("", "").toString("hex"), "b8628ab91c74f531603f6d5b45e730e54c123a7247b8978272c03f1e13560cea");
  assert.equal(
    authHashV2(DEFAULT_KASA_USERNAME, DEFAULT_KASA_PASSWORD).toString("hex"),
    "49fc4839a2733ffbf464337648f65dc411778d4c03ec82c5e4cccc682163fa64",
  );
  assert.equal(handshake1Hash("v2", LOCAL, REMOTE, hash).toString("hex"), "cdff876cc13bbc4558f60b61c346bbee70ff80bdc75fb794c9ad92969ec8d8b1");
  assert.equal(handshake2Hash("v2", LOCAL, REMOTE, hash).toString("hex"), "ddf87eccf292b534993842de0f2a17796504e528dbf935330575e9e4548c37b9");
  const cipher = new KlapCipher(LOCAL, REMOTE, hash);
  assert.equal(cipher.key.toString("hex"), "8568c4efaabe469059cd6d1e4bf3b7ef");
  assert.equal(cipher.iv.toString("hex"), "efc8e8e6241cd6e4df0163d3");
  assert.equal(cipher.seq, -571128325);
  assert.equal(cipher.sig.toString("hex"), "35731c60dc8bd39407c0440008aeef496d5d18f56a9b666560997d69");
  const { packet, seq } = cipher.encrypt(Buffer.from('{"system":{"get_sysinfo":{}}}'));
  assert.equal(seq, -571128324);
  assert.equal(
    packet.toString("hex"),
    "0ed2fd34f707de4ac8936cd0d85fcb37191c693db733025149c66a01f8f71bd8b55c060a8abbe5e402fe8552846f73534a7546faf4d95894840574ed39cd516b",
  );
  assert.equal(cipher.decrypt(packet).toString("utf8"), '{"system":{"get_sysinfo":{}}}');
});

function headers(cookie) {
  return {
    getSetCookie() {
      return cookie ? [`TP_SESSIONID=${cookie}; Path=/`] : [];
    },
    get(name) {
      return name === "set-cookie" && cookie ? `TP_SESSIONID=${cookie}` : null;
    },
  };
}

function mockKlapPlug({ version, username, password, relay = 0 }) {
  let localSeed = null;
  let auth = null;
  let state = relay;
  const calls = [];
  const request = async (url, { body } = {}) => {
    calls.push(url);
    if (url.endsWith("/app/handshake1")) {
      localSeed = Buffer.from(body);
      auth = version === "v1" ? authHashV1(username, password) : authHashV2(username, password);
      const hash = handshake1Hash(version, localSeed, REMOTE, auth);
      return { status: 200, body: Buffer.concat([REMOTE, hash]), headers: headers("sess-1") };
    }
    if (url.endsWith("/app/handshake2")) {
      const expected = handshake2Hash(version, localSeed, REMOTE, auth);
      if (!expected.equals(Buffer.from(body))) return { status: 403, body: Buffer.alloc(0), headers: headers() };
      return { status: 200, body: Buffer.alloc(0), headers: headers() };
    }
    const seq = Number(new URL(url).searchParams.get("seq"));
    const cipher = new KlapCipher(localSeed, REMOTE, auth);
    const plain = JSON.parse(cipher.decryptAt(Buffer.from(body), seq).toString("utf8"));
    let response;
    if (plain.system?.get_sysinfo) {
      response = {
        system: {
          get_sysinfo: {
            err_code: 0,
            alias: "Adam TV",
            model: "HS103",
            deviceId: "8006-hs103",
            mac: "AC:A7:F1:D9:40:DC",
            relay_state: state,
            mic_type: "IOT.SMARTPLUG",
            hw_ver: "5.0",
            sw_ver: "1.1.3",
          },
        },
      };
    } else if (plain.system?.set_relay_state) {
      state = plain.system.set_relay_state.state;
      response = { system: { set_relay_state: { err_code: 0 } } };
    } else {
      response = { system: { get_sysinfo: { err_code: -1 } } };
    }
    return {
      status: 200,
      body: cipher.encryptAt(Buffer.from(JSON.stringify(response)), seq),
      headers: headers(),
    };
  };
  return { request, calls, read: () => state };
}

test("a mocked KLAP v2 plug completes handshake and a relay round trip", async () => {
  const plug = mockKlapPlug({ version: "v2", username: "adam@example.com", password: "venue-secret" });
  const session = await openKlapSession("192.168.1.159", {
    username: "adam@example.com",
    password: "venue-secret",
  }, plug.request);
  assert.equal(session.version, "v2");
  assert.equal(session.label, "account");
  const info = await session.send({ system: { get_sysinfo: {} } });
  assert.equal(info.system.get_sysinfo.alias, "Adam TV");
  assert.equal(info.system.get_sysinfo.model, "HS103");
  assert.equal(info.system.get_sysinfo.sw_ver, "1.1.3");
  await session.send({ system: { set_relay_state: { state: 1 } } });
  assert.equal(plug.read(), 1);
  const again = await session.send({ system: { get_sysinfo: {} } });
  assert.equal(again.system.get_sysinfo.relay_state, 1);
});

test("KLAP tries v2, then v1, then blank and the Kasa default before asking for a login", async () => {
  const plug = mockKlapPlug({ version: "v1", username: DEFAULT_KASA_USERNAME, password: DEFAULT_KASA_PASSWORD });
  const session = await openKlapSession("192.168.1.159", { username: "", password: "" }, plug.request);
  assert.equal(session.version, "v1");
  assert.equal(session.label, "kasa");
  const info = await session.send({ system: { get_sysinfo: {} } });
  assert.equal(info.system.get_sysinfo.hw_ver, "5.0");
});

test("a KLAP plug with an unknown account asks for the Kasa login and hides the raw error", async () => {
  const plug = mockKlapPlug({ version: "v2", username: "owner@example.com", password: "real-secret" });
  await assert.rejects(
    () => openKlapSession("192.168.1.159", { username: "wrong@example.com", password: "nope" }, plug.request),
    (err) => {
      assert.equal(err.code, "plug-auth");
      assert.equal(err.message, PLUG_AUTH_MESSAGE);
      assert.equal(err.message.includes("403"), false);
      assert.equal(err.message.includes("real-secret"), false);
      return true;
    },
  );
});

test("discovery parses legacy and KLAP replies and merges them by MAC", () => {
  const legacyInfo = {
    system: {
      get_sysinfo: {
        alias: "Old name",
        model: "HS100",
        deviceId: "legacy-id",
        mac: "AC:A7:F1:D9:40:DC",
        mic_type: "IOT.SMARTPLUG",
        relay_state: 0,
      },
    },
  };
  const legacyPacket = Buffer.concat([Buffer.alloc(4), xorEncrypt(JSON.stringify(legacyInfo))]);
  const legacy = parseLegacyDiscovery(legacyPacket, "192.168.1.159");
  assert.equal(legacy.protocol, "legacy");
  assert.equal(legacy.mac, "AC:A7:F1:D9:40:DC");
  assert.equal(macKey(legacy.mac), macKey("AC-A7-F1-D9-40-DC"));

  const modernBody = Buffer.from(JSON.stringify({
    result: {
      device_id: "8006-hs103",
      device_name: "Adam TV",
      device_model: "HS103(US)",
      device_type: "IOT.SMARTPLUG",
      ip: "192.168.1.159",
      mac: "AC-A7-F1-D9-40-DC",
      mgt_encrypt_schm: { encrypt_type: "KLAP", lv: 2, http_port: 80 },
    },
  }));
  const modern = parseModernDiscovery(Buffer.concat([Buffer.alloc(16), modernBody]), "192.168.1.159");
  assert.equal(modern.protocol, "klap");
  assert.equal(modern.name, "Adam TV");
  const camera = parseModernDiscovery(Buffer.concat([Buffer.alloc(16), Buffer.from(JSON.stringify({
    result: { device_type: "IOT.IPCAMERA", device_id: "cam", ip: "192.168.1.20" },
  }))]), "192.168.1.20");
  assert.equal(camera, null);

  const merged = mergeByMac([legacy, modern]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].protocol, "klap");
  assert.equal(merged[0].name, "Adam TV");
  assert.equal(merged[0].host, "192.168.1.159");

  const probe = legacyDiscoveryPacket();
  const decoded = parseLegacyDiscovery(probe, "10.0.0.8");
  assert.equal(decoded, null);
});

test("the KLAP discovery query is the python-kasa 20002 packet and decrypts an AES reply", () => {
  const pair = createDiscoveryKeypair();
  const query = generateKlapDiscoveryQuery(pair.publicKey);
  assert.equal(query[0], 2);
  assert.equal(query.readUInt16BE(2), 1);
  const saved = query.readUInt32BE(12);
  const check = Buffer.from(query);
  check.writeUInt32BE(0x5A6B7C8D, 12);
  assert.equal(zlib.crc32(check) >>> 0, saved);
  const payload = JSON.parse(query.subarray(16).toString("utf8"));
  assert.match(payload.params.rsa_key, /BEGIN PUBLIC KEY/);

  const secret = crypto.randomBytes(32);
  const encryptedKey = crypto.publicEncrypt({
    key: pair.publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha1",
  }, secret);
  const iv = secret.subarray(16, 32);
  const cipher = crypto.createCipheriv("aes-128-cbc", secret.subarray(0, 16), iv);
  const inner = Buffer.from(JSON.stringify({ alias: "From discovery", model: "HS103" }));
  const encryptedData = Buffer.concat([cipher.update(inner), cipher.final()]).toString("base64");
  const body = Buffer.from(JSON.stringify({
    result: {
      device_id: "disc-1",
      device_type: "IOT.SMARTPLUG",
      ip: "192.168.1.159",
      mac: "ACA7F1D940DC",
      mgt_encrypt_schm: { encrypt_type: "KLAP", lv: 2 },
      encrypt_info: { sym_schm: "AES", key: encryptedKey.toString("base64"), data: encryptedData },
    },
  }));
  const device = parseModernDiscovery(Buffer.concat([Buffer.alloc(16), body]), "192.168.1.159", pair.privateKey);
  assert.equal(device.name, "From discovery");
  assert.equal(device.model, "HS103");
  assert.equal(device.protocol, "klap");
});

test("discovery broadcasts on each real subnet and skips APIPA adapters", () => {
  assert.equal(broadcastAddress("192.168.1.94", "255.255.255.0"), "192.168.1.255");
  const targets = discoveryTargets({
    Ethernet: [{ family: "IPv4", internal: false, address: "192.168.1.94", netmask: "255.255.255.0" }],
    "Wi-Fi 2": [{ family: "IPv4", internal: false, address: "169.254.117.159", netmask: "255.255.0.0" }],
    Bluetooth: [{ family: "IPv4", internal: false, address: "169.254.45.117", netmask: "255.255.0.0" }],
    Loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }],
  });
  const addresses = targets.map((target) => target.address);
  assert.ok(addresses.includes("192.168.1.255"));
  assert.ok(addresses.includes("255.255.255.255"));
  assert.equal(addresses.some((address) => address.startsWith("169.254.")), false);
  assert.equal(targets.every((target) => target.bind === "192.168.1.94"), true);
});

const ALLOWED_SHIP_HEADERS = new Set(["Host", "Content-Length", "Cookie", "Content-Type"]);

function startShipServer({ username, password, version = "v2", mode = "ok" } = {}) {
  let relay = 0;
  let localSeed = null;
  let auth = null;
  let inFlight = 0;
  let maxInFlight = 0;
  let handshakes = 0;
  let requests = 0;
  const seenHeaders = [];
  const server = net.createServer((socket) => {
    const chunks = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const split = buf.indexOf("\r\n\r\n");
      if (split < 0) return;
      const head = buf.subarray(0, split).toString("latin1");
      const length = Number(/Content-Length:\s*(\d+)/.exec(head)?.[1] || 0);
      if (buf.length < split + 4 + length) return;
      const body = buf.subarray(split + 4, split + 4 + length);
      chunks.length = 0;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const lines = head.split("\r\n");
      const names = lines.slice(1).filter(Boolean).map((line) => line.slice(0, line.indexOf(":")));
      seenHeaders.push(names);
      const bad = names.some((name) => !ALLOWED_SHIP_HEADERS.has(name));
      function respond(status, payload, extra = "") {
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
        const reason = status === 200 ? "OK" : "Bad Request";
        const res = `HTTP/1.1 ${status} ${reason}\r\n${extra}Server: SHIP 2.0\r\nContent-Length: ${data.length}\r\nContent-Type: text/html\r\n\r\n`;
        socket.write(Buffer.concat([Buffer.from(res, "latin1"), data]));
        inFlight -= 1;
      }
      if (bad || mode === "reject-all") return respond(400, Buffer.alloc(0));
      const requestLine = lines[0] || "";
      if (requestLine.startsWith("POST /app/handshake1")) {
        handshakes += 1;
        if (mode === "handshake-400") return respond(400, Buffer.alloc(0));
        localSeed = Buffer.from(body);
        auth = version === "v1" ? authHashV1(username, password) : authHashV2(username, password);
        const hash = handshake1Hash(version, localSeed, REMOTE, auth);
        return respond(200, Buffer.concat([REMOTE, hash]), "Set-Cookie: TP_SESSIONID=ship-session;TIMEOUT=86400\r\n");
      }
      if (requestLine.startsWith("POST /app/handshake2")) {
        const expected = handshake2Hash(version, localSeed, REMOTE, auth);
        if (!expected.equals(body)) return respond(403, Buffer.alloc(0));
        if (!/Cookie: TP_SESSIONID=ship-session/.test(head)) return respond(400, Buffer.alloc(0));
        return respond(200, Buffer.alloc(0));
      }
      if (requestLine.startsWith("POST /app/request")) {
        requests += 1;
        if (mode === "forbid-once" && requests === 1) return respond(403, Buffer.alloc(0));
        const seq = Number(/seq=(-?\d+)/.exec(requestLine)?.[1]);
        const cipher = new KlapCipher(localSeed, REMOTE, auth);
        const plain = JSON.parse(cipher.decryptAt(body, seq).toString("utf8"));
        let response;
        if (plain.system?.get_sysinfo) {
          response = {
            system: {
              get_sysinfo: {
                err_code: 0,
                alias: "Adam TV",
                model: "HS103",
                deviceId: "8006-hs103",
                mac: "AC:A7:F1:D9:40:DC",
                relay_state: relay,
                mic_type: "IOT.SMARTPLUG",
                hw_ver: "5.0",
                sw_ver: "1.1.3",
              },
            },
          };
        } else if (plain.system?.set_relay_state) {
          relay = plain.system.set_relay_state.state;
          response = { system: { set_relay_state: { err_code: 0 } } };
        } else {
          response = { system: { get_sysinfo: { err_code: -1 } } };
        }
        return respond(200, cipher.encryptAt(Buffer.from(JSON.stringify(response)), seq));
      }
      return respond(400, Buffer.alloc(0));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        seenHeaders: () => seenHeaders,
        maxInFlight: () => maxInFlight,
        handshakes: () => handshakes,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("SHIP 2.0 rejects extra headers and the raw KLAP client still turns the plug on", async () => {
  const ship = await startShipServer({ username: "adam@example.com", password: "venue-secret" });
  const logs = [];
  try {
    const bad = await new Promise((resolve) => {
      const socket = net.connect(ship.port, "127.0.0.1", () => {
        socket.write("POST /app/handshake1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 16\r\nUser-Agent: undici\r\nAccept-Encoding: gzip\r\n\r\n");
        socket.write(Buffer.alloc(16, 1));
      });
      const chunks = [];
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        const split = buf.indexOf("\r\n\r\n");
        if (split < 0) return;
        const head = buf.subarray(0, split).toString("latin1");
        const length = Number(/Content-Length:\s*(\d+)/.exec(head)?.[1] || 0);
        if (buf.length < split + 4 + length) return;
        socket.destroy();
        resolve({ status: Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1]), bytes: length });
      });
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.bytes, 0);

    const slot = { session: null, chain: Promise.resolve(), accountKey: "" };
    const account = { username: "adam@example.com", password: "venue-secret" };
    const host = `127.0.0.1:${ship.port}`;
    const first = createKlapDevice(host, account, undefined, { slot, log: (line) => logs.push(line) });
    const second = createKlapDevice(host, account, undefined, { slot, log: (line) => logs.push(line) });
    const info = await first.getSysInfo();
    assert.equal(info.alias, "Adam TV");
    assert.equal(info.sw_ver, "1.1.3");
    await Promise.all([first.setPowerState(true), second.setPowerState(false)]);
    const again = await first.getSysInfo();
    assert.equal(again.relay_state, 0);
    assert.equal(ship.handshakes(), 1);
    assert.equal(ship.maxInFlight(), 1);
    const namesets = ship.seenHeaders();
    assert.equal(namesets[0].includes("User-Agent"), true);
    assert.equal(namesets[0].includes("Accept-Encoding"), true);
    assert.ok(namesets.length > 1);
    for (const names of namesets.slice(1)) {
      assert.equal(names.every((name) => ALLOWED_SHIP_HEADERS.has(name)), true);
      assert.equal(names.includes("Host"), true);
      assert.equal(names.includes("Content-Length"), true);
      assert.equal(names.some((name) => name !== "Host" && name.toLowerCase() === "host"), false);
    }
    const text = logs.join("\n");
    assert.match(text, /handshake host=127\.0\.0\.1:\d+ ok version=v2 label=account/);
    assert.equal(text.includes("venue-secret"), false);
    assert.equal(text.includes("ship-session"), false);
    assert.equal(text.includes("TP_SESSIONID"), false);
  } finally {
    await ship.close();
  }
});

test("a SHIP handshake rejection is a transport failure, and a hash miss is the login error", async () => {
  const down = await startShipServer({ mode: "handshake-400" });
  try {
    const device = createKlapDevice(`127.0.0.1:${down.port}`, { username: "adam@example.com", password: "venue-secret" });
    await assert.rejects(() => device.getSysInfo(), (err) => {
      assert.equal(err.code, "plug-down");
      assert.equal(err.message, PLUG_DOWN_MESSAGE);
      assert.equal(err.message.includes("400"), false);
      return true;
    });
  } finally {
    await down.close();
  }
  const auth = await startShipServer({ username: "owner@example.com", password: "real-secret" });
  try {
    const device = createKlapDevice(`127.0.0.1:${auth.port}`, { username: "adam@example.com", password: "venue-secret" });
    await assert.rejects(() => device.getSysInfo(), (err) => {
      assert.equal(err.code, "plug-auth");
      assert.equal(err.message, PLUG_AUTH_MESSAGE);
      assert.equal(err.message.includes("real-secret"), false);
      return true;
    });
  } finally {
    await auth.close();
  }
});

test("a 403 after handshake starts a new session instead of asking for the login", async () => {
  const ship = await startShipServer({ username: "adam@example.com", password: "venue-secret", mode: "forbid-once" });
  try {
    const device = createKlapDevice(`127.0.0.1:${ship.port}`, { username: "adam@example.com", password: "venue-secret" });
    const info = await device.getSysInfo();
    assert.equal(info.model, "HS103");
    assert.equal(ship.handshakes() >= 2, true);
    await device.setPowerState(true);
    assert.equal((await device.getSysInfo()).relay_state, 1);
  } finally {
    await ship.close();
  }
});

test("the installer and the update script allow plug discovery UDP on Public networks", () => {
  const root = path.join(__dirname, "..");
  const installer = fs.readFileSync(path.join(root, "scripts", "install-kiosk-windows.ps1"), "utf8");
  const updater = fs.readFileSync(path.join(root, "scripts", "enable-autoupdate.ps1"), "utf8");
  const doc = fs.readFileSync(path.join(root, "KIOSK.md"), "utf8");
  const control = fs.readFileSync(path.join(root, "public", "control.js"), "utf8");
  for (const source of [installer, updater, doc]) {
    assert.match(source, /Pinball Land plug discovery/);
    assert.match(source, /UDP/);
    assert.match(source, /private,public|Private and Public/);
  }
  assert.match(control, /Save TP-Link login/);
  assert.match(control, /Add plug/);
  assert.match(control, /plug-notice/);
  assert.equal(control.includes("kasaSetup"), false);
});
