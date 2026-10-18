const crypto = require("crypto");

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

function cookieFrom(response) {
  const headers = response?.headers;
  const lines = [];
  if (headers && typeof headers.getSetCookie === "function") lines.push(...headers.getSetCookie());
  const single = headers && typeof headers.get === "function" ? headers.get("set-cookie") : "";
  if (single) lines.push(single);
  for (const line of lines) {
    const match = /TP_SESSIONID=([^;]+)/.exec(String(line || ""));
    if (match) return match[1];
  }
  return "";
}

async function defaultRequest(url, { body, cookie, timeoutMs = 4000 } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `TP_SESSIONID=${cookie}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw plugDownError();
  }
  const payload = Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: payload, headers: response.headers };
}

async function openKlapSession(host, account, request = defaultRequest) {
  const localSeed = crypto.randomBytes(16);
  const first = await request(`http://${host}/app/handshake1`, { body: localSeed });
  if (!first || first.status !== 200 || !first.body || first.body.length < 48) throw plugDownError();
  const remoteSeed = first.body.subarray(0, 16);
  const serverHash = first.body.subarray(16, 48);
  const cookie = cookieFrom(first);
  const matched = matchHandshake(localSeed, remoteSeed, serverHash, account);
  if (!matched) throw plugAuthError();
  const secondBody = handshake2Hash(matched.version, localSeed, remoteSeed, matched.hash);
  const second = await request(`http://${host}/app/handshake2`, { body: secondBody, cookie });
  if (!second || second.status !== 200) throw plugDownError();
  const cipher = new KlapCipher(localSeed, remoteSeed, matched.hash);
  return {
    version: matched.version,
    label: matched.label,
    async send(payload) {
      const plain = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
      const { packet, seq } = cipher.encrypt(plain);
      const response = await request(`http://${host}/app/request?seq=${seq}`, { body: packet, cookie });
      if (!response) throw plugDownError();
      if (response.status === 403) throw plugAuthError();
      if (response.status !== 200 || !response.body) throw plugDownError();
      let decoded;
      try {
        decoded = cipher.decrypt(response.body).toString("utf8");
        return JSON.parse(decoded);
      } catch (err) {
        if (err.code === "plug-auth" || err.code === "plug-down") throw err;
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

function createKlapDevice(host, account, request) {
  let session = null;
  async function send(payload) {
    if (!session) session = await openKlapSession(host, account, request);
    try {
      return await session.send(payload);
    } catch (err) {
      session = null;
      if (err.code === "plug-auth") throw err;
      session = await openKlapSession(host, account, request);
      return session.send(payload);
    }
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
  sysInfoFrom,
  plugAuthError,
  plugDownError,
};
