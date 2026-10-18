const crypto = require("crypto");
const net = require("net");

const PLUG_AUTH_MESSAGE = "This plug needs the TP-Link email and password from the Kasa app.";
const PLUG_DOWN_MESSAGE = "The plug did not answer.";

const DEFAULT_KASA_USERNAME = "kasa@tp-link.net";
const DEFAULT_KASA_PASSWORD = "kasaSetup";

function plugAuthError() {
  const error = new Error(PLUG_AUTH_MESSAGE);
  error.code = "plug-auth";
  error.status = 401;
  return error;
}

function plugDownError() {
  const error = new Error(PLUG_DOWN_MESSAGE);
  error.code = "plug-down";
  error.status = 502;
  return error;
}

function plugRetryError() {
  const error = new Error(PLUG_DOWN_MESSAGE);
  error.code = "plug-retry";
  error.status = 502;
  return error;
}

function sanitizePlugLog(line) {
  const text = String(line || "").replace(/[\r\n]+/g, " ").trim();
  if (!text) return "";
  if (/password|tp_sessionid|kasasetup|authorization|cookie\s*=|set-cookie/i.test(text)) return "";
  return text;
}

function md5(buffer) {
  return crypto.createHash("md5").update(buffer).digest();
}

function sha1(buffer) {
  return crypto.createHash("sha1").update(buffer).digest();
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

function authHashV1(username, password) {
  return md5(Buffer.concat([md5(Buffer.from(String(username))), md5(Buffer.from(String(password)))]));
}

function authHashV2(username, password) {
  return sha256(Buffer.concat([sha1(Buffer.from(String(username))), sha1(Buffer.from(String(password)))]));
}

function authHash(version, username, password) {
  return version === "v1" ? authHashV1(username, password) : authHashV2(username, password);
}

function handshake1Hash(version, localSeed, remoteSeed, hash) {
  const parts = version === "v1" ? [localSeed, hash] : [localSeed, remoteSeed, hash];
  return sha256(Buffer.concat(parts));
}

function handshake2Hash(version, localSeed, remoteSeed, hash) {
  const parts = version === "v1" ? [remoteSeed, hash] : [remoteSeed, localSeed, hash];
  return sha256(Buffer.concat(parts));
}

function credentialCandidates(account) {
  const list = [];
  const username = String(account?.username || "");
  const password = String(account?.password || "");
  if (username || password) list.push({ username, password, label: "account" });
  list.push({ username: "", password: "", label: "blank" });
  list.push({ username: DEFAULT_KASA_USERNAME, password: DEFAULT_KASA_PASSWORD, label: "kasa" });
  return list;
}

function matchHandshake(localSeed, remoteSeed, serverHash, account) {
  for (const version of ["v2", "v1"]) {
    for (const creds of credentialCandidates(account)) {
      const hash = authHash(version, creds.username, creds.password);
      const expected = handshake1Hash(version, localSeed, remoteSeed, hash);
      if (expected.equals(serverHash)) return { version, hash, label: creds.label };
    }
  }
  return null;
}

class KlapCipher {
  constructor(localSeed, remoteSeed, userHash) {
    this.localSeed = Buffer.from(localSeed);
    this.remoteSeed = Buffer.from(remoteSeed);
    this.userHash = Buffer.from(userHash);
    this.key = sha256(Buffer.concat([Buffer.from("lsk"), this.localSeed, this.remoteSeed, this.userHash])).subarray(0, 16);
    const fullIv = sha256(Buffer.concat([Buffer.from("iv"), this.localSeed, this.remoteSeed, this.userHash]));
    this.iv = fullIv.subarray(0, 12);
    this.seq = fullIv.readInt32BE(fullIv.length - 4);
    this.sig = sha256(Buffer.concat([Buffer.from("ldk"), this.localSeed, this.remoteSeed, this.userHash])).subarray(0, 28);
  }

  ivFor(seq) {
    const packed = Buffer.alloc(4);
    packed.writeInt32BE(seq, 0);
    return Buffer.concat([this.iv, packed]);
  }

  encryptAt(plain, seq) {
    const cipher = crypto.createCipheriv("aes-128-cbc", this.key, this.ivFor(seq));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const packed = Buffer.alloc(4);
    packed.writeInt32BE(seq, 0);
    const signature = sha256(Buffer.concat([this.sig, packed, ciphertext]));
    return Buffer.concat([signature, ciphertext]);
  }

  decryptAt(packet, seq) {
    const body = packet.subarray(32);
    const decipher = crypto.createDecipheriv("aes-128-cbc", this.key, this.ivFor(seq));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  encrypt(plain) {
    this.seq += 1;
    return { packet: this.encryptAt(plain, this.seq), seq: this.seq };
  }

  decrypt(packet) {
    return this.decryptAt(packet, this.seq);
  }
}

function cookieLines(response) {
  const headers = response?.headers;
  const lines = [];
  if (headers && typeof headers.getSetCookie === "function") lines.push(...headers.getSetCookie());
  const single = headers && typeof headers.get === "function" ? headers.get("set-cookie") : "";
  if (single) lines.push(single);
  return lines;
}

function readCookies(response) {
  const bag = {};
  for (const line of cookieLines(response)) {
    for (const part of String(line || "").split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (/^(Path|Domain|Expires|Max-Age|SameSite|HttpOnly|Secure)$/i.test(name)) continue;
      if (!bag[name]) bag[name] = value;
    }
  }
  return bag;
}

function cookieFrom(response) {
  const session = readCookies(response).TP_SESSIONID || "";
  if (!session || session === "TIMEOUT") return "";
  return session;
}

function emitLog(log, line) {
  if (typeof log !== "function") return;
  const clean = sanitizePlugLog(line);
  if (clean) log(clean);
}

function klapHttpRequest(urlString, { body, cookie, timeoutMs = 4000 } = {}) {
  const url = new URL(urlString);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  const hostHeader = url.port && url.port !== "80" ? `${url.hostname}:${url.port}` : url.hostname;
  const lines = [
    `Host: ${hostHeader}`,
    `Content-Length: ${payload.length}`,
  ];
  if (cookie) lines.push(`Cookie: TP_SESSIONID=${cookie}`);
  const head = `POST ${url.pathname}${url.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
  const packet = Buffer.concat([Buffer.from(head, "latin1"), payload]);
  const port = Number(url.port) || 80;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port });
    let settled = false;
    const chunks = [];
    const timer = setTimeout(() => done(plugDownError()), timeoutMs);
    function done(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    }
    socket.setNoDelay(true);
    socket.on("error", () => done(plugDownError()));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const split = buf.indexOf("\r\n\r\n");
      if (split < 0) return;
      const headerText = buf.subarray(0, split).toString("latin1");
      const status = /^HTTP\/1\.[01] (\d+)/.exec(headerText);
      const lengthMatch = /content-length:\s*(\d+)/i.exec(headerText);
      const length = lengthMatch ? Number(lengthMatch[1]) : 0;
      const bodyStart = split + 4;
      if (buf.length < bodyStart + length) return;
      const setCookies = [];
      for (const line of headerText.split("\r\n").slice(1)) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        if (/^set-cookie$/i.test(line.slice(0, idx).trim())) setCookies.push(line.slice(idx + 1).trim());
      }
      done(null, {
        status: Number(status?.[1] || 0),
        body: buf.subarray(bodyStart, bodyStart + length),
        headers: {
          getSetCookie: () => setCookies,
          get(name) {
            return String(name || "").toLowerCase() === "set-cookie" ? setCookies.join(", ") : null;
          },
        },
      });
    });
    socket.on("connect", () => {
      socket.write(packet);
    });
  });
}

async function defaultRequest(url, options = {}) {
  try {
    return await klapHttpRequest(url, options);
  } catch (err) {
    if (err.code === "plug-down" || err.code === "plug-auth" || err.code === "plug-retry") throw err;
    throw plugDownError();
  }
}

function sessionExpiry(response) {
  const timeout = Number(readCookies(response).TIMEOUT);
  const seconds = Number.isFinite(timeout) && timeout > 0 ? timeout : 86400;
  return Date.now() + Math.max(1, seconds - 60) * 1000;
}

async function openKlapSession(host, account, request = defaultRequest, log = () => {}) {
  const localSeed = crypto.randomBytes(16);
  const first = await request(`http://${host}/app/handshake1`, { body: localSeed });
  emitLog(log, `handshake host=${host} status=${first?.status || 0} bytes=${first?.body?.length || 0}`);
  if (!first || first.status !== 200 || !first.body || first.body.length < 48) throw plugDownError();
  const remoteSeed = first.body.subarray(0, 16);
  const serverHash = first.body.subarray(16, 48);
  const cookies = readCookies(first);
  if (cookies.TP_SESSIONID === "TIMEOUT") throw plugRetryError();
  const cookie = cookieFrom(first);
  const matched = matchHandshake(localSeed, remoteSeed, serverHash, account);
  if (!matched) {
    emitLog(log, `handshake host=${host} auth-mismatch`);
    throw plugAuthError();
  }
  const secondBody = handshake2Hash(matched.version, localSeed, remoteSeed, matched.hash);
  const second = await request(`http://${host}/app/handshake2`, { body: secondBody, cookie });
  if (!second || second.status !== 200) throw plugDownError();
  emitLog(log, `handshake host=${host} ok version=${matched.version} label=${matched.label}`);
  const cipher = new KlapCipher(localSeed, remoteSeed, matched.hash);
  const expiresAt = sessionExpiry(first);
  return {
    version: matched.version,
    label: matched.label,
    expired() {
      return Date.now() >= expiresAt;
    },
    async send(payload) {
      if (Date.now() >= expiresAt) throw plugRetryError();
      const plain = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
      const { packet, seq } = cipher.encrypt(plain);
      const response = await request(`http://${host}/app/request?seq=${seq}`, { body: packet, cookie });
      if (!response) throw plugDownError();
      const again = readCookies(response);
      if (response.status === 403 || again.TP_SESSIONID === "TIMEOUT") {
        emitLog(log, `request host=${host} status=${response.status} retry`);
        throw plugRetryError();
      }
      if (response.status !== 200 || !response.body) throw plugDownError();
      let decoded;
      try {
        decoded = cipher.decrypt(response.body).toString("utf8");
        return JSON.parse(decoded);
      } catch (err) {
        if (err.code === "plug-auth" || err.code === "plug-down" || err.code === "plug-retry") throw err;
        throw plugDownError();
      }
    },
  };
}

function sysInfoFrom(payload) {
  const info = payload?.system?.get_sysinfo;
  if (!info || typeof info !== "object") throw plugDownError();
  if (info.err_code && Number(info.err_code) !== 0) throw plugDownError();
  return info;
}

function createKlapDevice(host, account, request = defaultRequest, options = {}) {
  const slot = options.slot || { session: null, chain: Promise.resolve(), accountKey: "" };
  const log = options.log || (() => {});
  const accountKey = `${account?.username || ""}\0${account?.password || ""}`;
  function enqueue(fn) {
    const run = slot.chain.then(fn, fn);
    slot.chain = run.then(() => {}, () => {});
    return run;
  }
  async function ensureSession(force) {
    if (!force && slot.session && slot.accountKey === accountKey && !slot.session.expired()) return slot.session;
    slot.session = null;
    slot.accountKey = "";
    const opened = await openKlapSession(host, account, request, log);
    slot.session = opened;
    slot.accountKey = accountKey;
    return opened;
  }
  async function send(payload) {
    return enqueue(async () => {
      try {
        const current = await ensureSession(false);
        return await current.send(payload);
      } catch (err) {
        if (err.code === "plug-auth") {
          slot.session = null;
          throw err;
        }
        if (err.code !== "plug-retry") {
          slot.session = null;
          if (err.code === "plug-down") throw err;
          throw plugDownError();
        }
        try {
          const current = await ensureSession(true);
          return await current.send(payload);
        } catch (again) {
          slot.session = null;
          if (again.code === "plug-auth") throw again;
          throw plugDownError();
        }
      }
    });
  }
  return {
    host,
    protocol: "klap",
    async getSysInfo() {
      return sysInfoFrom(await send({ system: { get_sysinfo: {} } }));
    },
    async getPowerState() {
      const info = sysInfoFrom(await send({ system: { get_sysinfo: {} } }));
      return Number(info.relay_state) === 1;
    },
    async setPowerState(on) {
      const payload = await send({ system: { set_relay_state: { state: on ? 1 : 0 } } });
      const code = payload?.system?.set_relay_state?.err_code;
      if (code && Number(code) !== 0) throw plugDownError();
    },
  };
}

module.exports = {
  PLUG_AUTH_MESSAGE,
  PLUG_DOWN_MESSAGE,
  DEFAULT_KASA_USERNAME,
  DEFAULT_KASA_PASSWORD,
  authHashV1,
  authHashV2,
  authHash,
  handshake1Hash,
  handshake2Hash,
  matchHandshake,
  KlapCipher,
  openKlapSession,
  createKlapDevice,
  klapHttpRequest,
  sanitizePlugLog,
  sysInfoFrom,
  plugAuthError,
  plugDownError,
};
