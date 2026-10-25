const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { parseCloudflareLine } = require("./public-access");

const CLOUDFLARED_RELEASE = "2026.10.1";
const CLOUDFLARED_ASSETS = {
  "win32:x64": {
    name: "cloudflared-windows-amd64.exe",
    file: "cloudflared.exe",
    sha256: "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6",
  },
  "linux:x64": {
    name: "cloudflared-linux-amd64",
    file: "cloudflared",
    sha256: "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586",
  },
};

function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  return CLOUDFLARED_ASSETS[`${platform}:${arch}`] || null;
}

function cloudflaredUrl(asset) {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_RELEASE}/${asset.name}`;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function ensureCloudflared({
  binDir,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const asset = cloudflaredAsset(platform, arch);
  if (!asset) {
    throw Object.assign(new Error(`No Cloudflare build for ${platform} ${arch}`), { code: "unsupported" });
  }
  if (!binDir) throw new Error("Cloudflare needs a bin directory");
  await fsp.mkdir(binDir, { recursive: true });
  const dest = path.join(binDir, asset.file);
  if (fs.existsSync(dest)) {
    const hash = await sha256File(dest);
    if (hash === asset.sha256) {
      if (platform !== "win32") await fsp.chmod(dest, 0o755).catch(() => {});
      return dest;
    }
    await fsp.unlink(dest).catch(() => {});
  }
  let response;
  try {
    response = await fetchImpl(cloudflaredUrl(asset), { redirect: "follow" });
  } catch (err) {
    throw Object.assign(new Error(err.message || "download failed"), { code: "download" });
  }
  if (!response?.ok) {
    throw Object.assign(new Error(`download ${response?.status || "failed"}`), { code: "download" });
  }
  const data = Buffer.from(await response.arrayBuffer());
  const hash = sha256Buffer(data);
  if (hash !== asset.sha256) {
    throw Object.assign(new Error("checksum"), { code: "checksum" });
  }
  const partial = `${dest}.partial`;
  await fsp.writeFile(partial, data);
  await fsp.rename(partial, dest);
  if (platform !== "win32") await fsp.chmod(dest, 0o755).catch(() => {});
  return dest;
}

function plainTunnelError(err) {
  if (!err) return "Cloudflare did not start.";
  if (err.code === "checksum") return "The Cloudflare download failed its checksum check and was not started.";
  if (err.code === "download") return "Cloudflare could not be downloaded. Guests stay on the venue WiFi until this PC can reach GitHub.";
  if (err.code === "unsupported") return "Cloudflare is not available for this PC.";
  if (err.code === "ENOENT" || err.code === "spawn") {
    const where = err.path ? ` (${err.path})` : "";
    return `Cloudflare did not start. The downloaded program could not be launched${where}.`;
  }
  return `Cloudflare did not start: ${err.message || "the program could not be launched"}.`;
}

function shouldRestartTunnel({ failing = false, passedOnce = false, failures = 0, failingForMs = 0 } = {}) {
  if (!failing) return false;
  if (passedOnce && failures >= 3) return true;
  if (failingForMs >= 5 * 60 * 1000) return true;
  return false;
}

function formatTunnelCheck({ url, ok, status = 0, error = "" } = {}) {
  const outcome = ok ? "pass" : "fail";
  const statusText = status ? ` status=${status}` : "";
  const errorText = error ? ` error=${error}` : "";
  return `check ${url} ${outcome}${statusText}${errorText}`;
}

function createCloudflareTunnel({
  binDir,
  logFile,
  port = 3010,
  fetchImpl = fetch,
  spawnImpl = spawn,
  platform = process.platform,
  arch = process.arch,
  backoffStart = 2000,
  onChange = null,
} = {}) {
  let child = null;
  let url = "";
  let detail = "Cloudflare is off.";
  let running = false;
  let attempt = 0;
  let timer = null;
  let starting = false;
  let useHttp2 = false;
  let registrationErrors = 0;

  function writeLog(line) {
    const text = String(line || "").trim();
    if (!logFile || !text) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
    } catch {
      // A locked log is tried again on the next line.
    }
  }

  function publish() {
    if (typeof onChange === "function") onChange({ url, detail });
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function kill() {
    const current = child;
    child = null;
    if (!current) return;
    try { current.kill(); } catch { /* already gone */ }
  }

  function schedule() {
    if (!running) return;
    const delay = Math.min(30000, backoffStart * (2 ** Math.min(attempt, 4)));
    attempt += 1;
    clearTimer();
    timer = setTimeout(() => {
      launch().catch(() => {});
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function launch() {
    if (!running || starting || child) return;
    starting = true;
    url = "";
    detail = "Cloudflare is starting. The guest link will show here when it is ready.";
    publish();
    try {
      const bin = await ensureCloudflared({ binDir, fetchImpl, platform, arch });
      if (!bin || !path.isAbsolute(bin)) {
        throw Object.assign(new Error("Cloudflare must be started from its downloaded file, not from PATH"), { code: "spawn" });
      }
      const targetPort = typeof port === "function" ? port() : port;
      const target = `http://127.0.0.1:${targetPort}`;
      const args = ["tunnel", "--no-autoupdate"];
      if (useHttp2) args.push("--protocol", "http2");
      args.push("--url", target);
      writeLog(`start ${bin} ${target}${useHttp2 ? " protocol=http2" : ""}`);
      const spawned = spawnImpl(bin, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      if (!spawned) throw Object.assign(new Error("spawn failed"), { code: "spawn", path: bin });
      child = spawned;
      starting = false;
      registrationErrors = 0;
      const take = (chunk) => {
        const text = String(chunk || "");
        for (const line of text.split(/\r?\n/)) {
          writeLog(line);
          if (!useHttp2 && /quic/i.test(line)) {
            useHttp2 = true;
            writeLog("switching to http2 after a QUIC failure");
            try { spawned.kill(); } catch { /* already gone */ }
          }
          if (/tunnel not found|register tunnel error/i.test(line)) {
            registrationErrors += 1;
            if (registrationErrors >= 3) {
              registrationErrors = 0;
              url = "";
              detail = "Cloudflare lost the tunnel. Starting a fresh link.";
              writeLog("restart tunnel registration failed");
              publish();
              try { spawned.kill(); } catch { /* exit handler starts the next process */ }
            }
          }
        }
        const found = parseCloudflareLine(text);
        if (found) {
          url = found;
          attempt = 0;
          detail = `Cloudflare is up. Guests use ${found}`;
          writeLog(`url ${found}`);
          publish();
        }
      };
      spawned.stdout?.on("data", take);
      spawned.stderr?.on("data", take);
      spawned.on("error", (err) => {
        if (child === spawned) child = null;
        const failure = Object.assign(err, { path: err.path || bin });
        detail = plainTunnelError(failure);
        writeLog(`spawn error ${bin} ${failure.code || ""} ${failure.message}`);
        publish();
        if (running) schedule();
      });
      spawned.on("exit", (code) => {
        writeLog(`exit ${code}`);
        if (child !== spawned) return;
        child = null;
        url = "";
        if (!running) return;
        detail = "Cloudflare stopped. It will try again shortly.";
        publish();
        schedule();
      });
    } catch (err) {
      starting = false;
      child = null;
      detail = plainTunnelError(err);
      writeLog(`error ${err.code || ""} ${err.message}`);
      publish();
      if (running) schedule();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      launch().catch(() => {});
    },
    stop() {
      running = false;
      clearTimer();
      kill();
      url = "";
      detail = "Cloudflare is off.";
      publish();
    },
    status() {
      return { url, detail, http2: useHttp2 };
    },
    restart(reason) {
      writeLog(`restart ${reason || "requested"}`);
      url = "";
      const current = child;
      if (!current) {
        launch().catch(() => {});
        return;
      }
      try { current.kill(); } catch { /* exit handler starts the next one */ }
    },
  };
}

module.exports = {
  CLOUDFLARED_RELEASE,
  CLOUDFLARED_ASSETS,
  cloudflaredAsset,
  cloudflaredUrl,
  ensureCloudflared,
  createCloudflareTunnel,
  formatTunnelCheck,
  plainTunnelError,
  sha256Buffer,
  shouldRestartTunnel,
};
