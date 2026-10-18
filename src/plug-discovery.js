const crypto = require("crypto");
const dgram = require("dgram");
const os = require("os");
const zlib = require("zlib");

const LEGACY_PORT = 9999;
const KLAP_DISCOVERY_PORT = 20002;
const DISCOVERY_QUERY_2 = Buffer.from("020000010000000000000000463cb5d3", "hex");

function macKey(value) {
  const hex = String(value || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  return hex.length === 12 ? hex : "";
}

function formatMac(value) {
  const key = macKey(value);
  if (!key) return "";
  return key.match(/.{2}/g).join(":");
}

function isIpv4(value) {
  const text = String(value || "").trim();
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function broadcastAddress(address, netmask) {
  if (!isIpv4(address) || !isIpv4(netmask)) return "";
  const ip = address.split(".").map(Number);
  const mask = netmask.split(".").map(Number);
  return ip.map((part, index) => (part | (~mask[index] & 255)) >>> 0).join(".");
}

function discoveryTargets(interfaces = os.networkInterfaces()) {
  const targets = [];
  const seen = new Set();
  const add = (address, bind) => {
    if (!address || seen.has(`${bind || ""}>${address}`)) return;
    seen.add(`${bind || ""}>${address}`);
    targets.push({ address, bind: bind || "0.0.0.0" });
  };
  for (const addrs of Object.values(interfaces || {})) {
    for (const addr of addrs || []) {
      const family = addr.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (addr.internal) continue;
      if (String(addr.address || "").startsWith("169.254.")) continue;
      const broadcast = broadcastAddress(addr.address, addr.netmask);
      if (!broadcast || broadcast.startsWith("169.254.")) continue;
      add(broadcast, addr.address);
      add("255.255.255.255", addr.address);
    }
  }
  if (!targets.length) add("255.255.255.255", "0.0.0.0");
  return targets;
}

function xorCrypt(buffer) {
  const out = Buffer.alloc(buffer.length);
  let key = 171;
  for (let i = 0; i < buffer.length; i += 1) {
    out[i] = buffer[i] ^ key;
    key = buffer[i];
  }
  return out;
}

function xorEncrypt(text) {
  const input = Buffer.from(String(text));
  const out = Buffer.alloc(input.length);
  let key = 171;
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i] ^ key;
    key = out[i];
  }
  return out;
}

function legacyDiscoveryPacket() {
  return xorEncrypt(JSON.stringify({ system: { get_sysinfo: {} } }));
}

function generateKlapDiscoveryQuery(publicPem) {
  const pem = Buffer.isBuffer(publicPem) ? publicPem : Buffer.from(String(publicPem));
  const payload = Buffer.from(JSON.stringify({ params: { rsa_key: pem.toString("utf8") } }));
  const header = Buffer.alloc(16);
  header.writeUInt8(2, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(payload.length, 4);
  header.writeUInt8(17, 6);
  header.writeUInt8(0, 7);
  crypto.randomBytes(4).copy(header, 8);
  header.writeUInt32BE(0x5A6B7C8D, 12);
  const query = Buffer.concat([header, payload]);
  query.writeUInt32BE(zlib.crc32(query) >>> 0, 12);
  return query;
}

function createDiscoveryKeypair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 65537,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function decryptDiscoverySecret(privateKey, encryptedKey) {
  return crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha1",
  }, encryptedKey);
}

function decryptDiscoveryData(privateKey, encryptInfo) {
  if (!encryptInfo || encryptInfo.sym_schm !== "AES" || !encryptInfo.key || !encryptInfo.data) return null;
  const secret = decryptDiscoverySecret(privateKey, Buffer.from(String(encryptInfo.key), "base64"));
  const key = secret.subarray(0, 16);
  const iv = secret.subarray(16, 32);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(encryptInfo.data), "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8"));
}

function plugType(value) {
  const type = String(value || "");
  if (!type) return true;
  return type === "IOT.SMARTPLUG" || type === "IOT.SMARTPLUGSWITCH";
}

function deviceFromLegacy(info, host) {
  const sys = info?.system?.get_sysinfo || info;
  if (!sys || typeof sys !== "object") return null;
  const type = sys.mic_type || sys.type || "";
  if (!plugType(type)) return null;
  const mac = formatMac(sys.mac || sys.ethernet_mac);
  const id = String(sys.deviceId || sys.device_id || mac || "").trim();
  const name = String(sys.alias || sys.dev_name || "").trim();
  if (!id && !name) return null;
  return {
    id: id || host,
    name: String(sys.alias || sys.dev_name || host || "Kasa plug"),
    host: String(sys.ip || host || "").trim(),
    model: String(sys.model || sys.device_model || "").trim(),
    mac,
    protocol: "legacy",
    needsLogin: false,
    on: typeof sys.relay_state === "number" ? sys.relay_state === 1 : null,
  };
}

function parseLegacyDiscovery(message, host) {
  if (!message || !message.length) return null;
  const slices = [message];
  if (message.length > 4) slices.push(message.subarray(4));
  for (const slice of slices) {
    try {
      const text = xorCrypt(slice).toString("utf8");
      const jsonStart = text.indexOf("{");
      if (jsonStart < 0) continue;
      const info = JSON.parse(text.slice(jsonStart));
      const device = deviceFromLegacy(info, host);
      if (device) return device;
    } catch {
      // try the other slice
    }
  }
  return null;
}

function deviceFromModern(info, host) {
  const result = info?.result && typeof info.result === "object" ? info.result : info;
  if (!result || typeof result !== "object") return null;
  const type = result.device_type || result.mic_type || result.type || "";
  if (!plugType(type)) return null;
  const scheme = result.mgt_encrypt_schm || {};
  const encryptType = String(scheme.encrypt_type || result.encrypt_type || "");
  const protocol = /klap/i.test(encryptType) || Number(scheme.lv) >= 2 ? "klap" : "legacy";
  const mac = formatMac(result.mac || result.ethernet_mac);
  const decrypted = result.decrypted_data && typeof result.decrypted_data === "object" ? result.decrypted_data : {};
  const id = String(result.device_id || result.deviceId || mac || "").trim();
  const name = String(decrypted.alias || result.device_name || result.alias || "").trim();
  if (!id && !name) return null;
  return {
    id: id || host,
    name: String(decrypted.alias || result.device_name || result.alias || host || "Kasa plug"),
    host: String(result.ip || decrypted.ip || host || "").trim(),
    model: String(decrypted.model || result.device_model || result.model || "").trim(),
    mac,
    protocol,
    needsLogin: false,
    on: null,
  };
}

function parseModernDiscovery(message, host, privateKey) {
  if (!message || message.length < 16) return null;
  let info;
  try {
    const text = message.subarray(16).toString("utf8");
    const start = text.indexOf("{");
    if (start < 0) return null;
    info = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  const result = info?.result;
  if (result?.encrypt_info && privateKey) {
    try {
      result.decrypted_data = decryptDiscoveryData(privateKey, result.encrypt_info);
    } catch {
      result.decrypted_data = null;
    }
  }
  return deviceFromModern(info, host);
}

function parseDiscoveryDatagram(message, host, privateKey) {
  return parseModernDiscovery(message, host, privateKey) || parseLegacyDiscovery(message, host);
}

function mergeByMac(devices) {
  const merged = new Map();
  for (const device of devices) {
    if (!device || !device.host) continue;
    const key = macKey(device.mac) || `host:${device.host}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...device });
      continue;
    }
    const preferNext = prev.protocol !== "klap" && device.protocol === "klap";
    const base = preferNext ? prev : device;
    const extra = preferNext ? device : prev;
    merged.set(key, {
      ...base,
      ...extra,
      protocol: prev.protocol === "klap" || device.protocol === "klap" ? "klap" : (extra.protocol || base.protocol),
      name: extra.name && extra.name !== extra.host ? extra.name : base.name,
      model: extra.model || base.model,
      mac: extra.mac || base.mac,
      host: extra.host || base.host,
      id: extra.id || base.id,
    });
  }
  return [...merged.values()];
}

function bindSocket(address) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const fail = (err) => {
      socket.close();
      reject(err);
    };
    socket.once("error", fail);
    socket.bind(0, address, () => {
      socket.removeListener("error", fail);
      try {
        socket.setBroadcast(true);
      } catch {
        // some stacks reject broadcast on a bound address
      }
      resolve(socket);
    });
  });
}

function sendTo(socket, packet, port, address) {
  return new Promise((resolve) => {
    socket.send(packet, 0, packet.length, port, address, () => resolve());
  });
}

async function collectDiscoveryReplies({ interfaces, timeoutMs = 3000, privateKey, publicPem } = {}) {
  const targets = discoveryTargets(interfaces);
  const binds = [...new Set(targets.map((target) => target.bind))];
  const sockets = [];
  const found = [];
  const seen = new Set();
  for (const bind of binds) {
    try {
      const socket = await bindSocket(bind);
      socket.on("message", (message, rinfo) => {
        if (!rinfo || String(rinfo.address || "").startsWith("169.254.")) return;
        const device = parseDiscoveryDatagram(message, rinfo.address, privateKey);
        if (!device) return;
        const key = `${macKey(device.mac) || device.host}:${device.protocol}`;
        if (seen.has(key)) return;
        seen.add(key);
        found.push(device);
      });
      socket.on("error", () => {});
      sockets.push({ socket, bind });
    } catch {
      // this adapter cannot broadcast
    }
  }
  const klapQuery = publicPem ? generateKlapDiscoveryQuery(publicPem) : null;
  const legacy = legacyDiscoveryPacket();
  await Promise.all(sockets.map(async ({ socket, bind }) => {
    const relevant = targets.filter((target) => target.bind === bind);
    for (const target of relevant) {
      await sendTo(socket, legacy, LEGACY_PORT, target.address);
      if (klapQuery) await sendTo(socket, klapQuery, KLAP_DISCOVERY_PORT, target.address);
      await sendTo(socket, DISCOVERY_QUERY_2, KLAP_DISCOVERY_PORT, target.address);
    }
  }));
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  for (const { socket } of sockets) {
    try { socket.close(); } catch { /* already closed */ }
  }
  return mergeByMac(found);
}

module.exports = {
  LEGACY_PORT,
  KLAP_DISCOVERY_PORT,
  DISCOVERY_QUERY_2,
  macKey,
  formatMac,
  isIpv4,
  broadcastAddress,
  discoveryTargets,
  xorEncrypt,
  xorCrypt,
  legacyDiscoveryPacket,
  generateKlapDiscoveryQuery,
  createDiscoveryKeypair,
  decryptDiscoveryData,
  parseLegacyDiscovery,
  parseModernDiscovery,
  parseDiscoveryDatagram,
  mergeByMac,
  collectDiscoveryReplies,
};
