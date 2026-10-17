const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

function ffmpegBinary() {
  try {
    const bundled = require("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // The system ffmpeg is only a fallback when the package binary is missing.
  }
  return "ffmpeg";
}

function runProcess(bin, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(bin)} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function moovBeforeMdat(file) {
  const handle = await fsp.open(file, "r");
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    let moov = -1;
    let mdat = -1;
    while (offset + 8 <= size && (moov < 0 || mdat < 0)) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        const wide = header.readBigUInt64BE(8);
        boxSize = wide > BigInt(Number.MAX_SAFE_INTEGER) ? size - offset : Number(wide);
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (!Number.isFinite(boxSize) || boxSize < headerLen) break;
      if (type === "moov" && moov < 0) moov = offset;
      if (type === "mdat" && mdat < 0) mdat = offset;
      offset += boxSize;
    }
    return moov >= 0 && (mdat < 0 || moov < mdat);
  } finally {
    await handle.close();
  }
}

function parseProbe(stderr) {
  const video = /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Video: ([A-Za-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  const audio = /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Audio: ([A-Za-z0-9_]+)/.exec(stderr);
  return {
    videoCodec: (video?.[1] || "").toLowerCase(),
    width: Number(video?.[2]) || 0,
    height: Number(video?.[3]) || 0,
    audioCodec: (audio?.[1] || "").toLowerCase(),
  };
}

async function probeFile(ffmpeg, file) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-i", file]);
  const info = parseProbe(result.stderr);
  info.faststart = await moovBeforeMdat(file);
  info.playable = info.videoCodec === "h264"
    && info.width > 0
    && info.height > 0
    && info.width <= 1920
    && info.height <= 1080
    && (!info.audioCodec || info.audioCodec === "aac")
    && info.faststart;
  return info;
}

async function remuxOrTranscode(ffmpeg, source, dest, info) {
  const codecsOk = info.videoCodec === "h264"
    && info.width > 0
    && info.height > 0
    && info.width <= 1920
    && info.height <= 1080
    && (!info.audioCodec || info.audioCodec === "aac");
  const args = ["-y", "-hide_banner", "-i", source];
  if (codecsOk) {
    args.push("-c", "copy", "-movflags", "+faststart", dest);
  } else {
    args.push(
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-profile:v", "high",
      "-c:a", "aac",
      "-b:a", "160k",
      "-movflags", "+faststart",
      dest,
    );
  }
  const result = await runProcess(ffmpeg, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.split("\n").filter(Boolean).slice(-3).join(" ") || "ffmpeg failed");
  }
}

async function downloadResumable(url, dest, fetchImpl = fetch) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let existing = 0;
  try {
    existing = (await fsp.stat(dest)).size;
  } catch {
    existing = 0;
  }
  const headers = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;
  const response = await fetchImpl(url, { headers, redirect: "follow" });
  if (response.status === 416) return dest;
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`download ${response.status}`);
  }
  const restart = response.status === 200;
  const handle = await fsp.open(dest, restart ? "w" : "a");
  try {
    if (!response.body) throw new Error("download had no body");
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
  return dest;
}

function readyPath(cacheDir, id) {
  return path.join(cacheDir, `${id}.mp4`);
}

function createClipCache({
  items = [],
  cacheDir,
  logFile,
  ffmpeg = ffmpegBinary(),
  fetchImpl = fetch,
  nightlyAt = () => "03:17",
  ids = null,
  logger = console,
} = {}) {
  if (!cacheDir) throw new Error("clip cache needs a directory");
  const allow = ids ? new Set(ids) : null;
  const wanted = () => (items || []).filter((item) => item?.id && item.streamUrl && (!allow || allow.has(item.id)));
  let stopped = false;
  let running = false;
  let lastNight = "";
  const status = new Map();

  function writeLog(line) {
    if (!logFile) return;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch (err) {
      logger.error?.(err);
    }
  }

  function snapshot() {
    return wanted().map((item) => {
      const row = status.get(item.id) || {};
      return {
        id: item.id,
        title: item.title,
        holiday: item.holiday,
        ready: Boolean(row.ready),
        error: row.error || null,
      };
    });
  }

  function isReady(id) {
    const file = readyPath(cacheDir, id);
    return Boolean(status.get(id)?.ready) && fs.existsSync(file);
  }

  function fileFor(id) {
    if (!isReady(id)) return null;
    const file = readyPath(cacheDir, id);
    return fs.existsSync(file) ? file : null;
  }

  async function ensureOne(item, { force = false } = {}) {
    const finalFile = readyPath(cacheDir, item.id);
    const part = `${finalFile}.part`;
    if (!force && status.get(item.id)?.ready && fs.existsSync(finalFile)) return;
    if (fs.existsSync(finalFile)) {
      const info = await probeFile(ffmpeg, finalFile);
      if (info.playable) {
        status.set(item.id, { ready: true, error: null });
        return;
      }
    }
    status.set(item.id, { ready: false, error: null });
    writeLog(`cache start ${item.id}`);
    await downloadResumable(item.streamUrl, part, fetchImpl);
    const probed = await probeFile(ffmpeg, part);
    if (probed.playable) {
      await fsp.rename(part, finalFile);
    } else {
      const tmp = `${finalFile}.tmp.mp4`;
      await remuxOrTranscode(ffmpeg, part, tmp, probed);
      const checked = await probeFile(ffmpeg, tmp);
      if (!checked.playable) throw new Error(`cached file is not playable h264 faststart (${checked.videoCodec} ${checked.width}x${checked.height} moov=${checked.faststart})`);
      await fsp.rename(tmp, finalFile);
      await fsp.unlink(part).catch(() => {});
    }
    status.set(item.id, { ready: true, error: null });
    writeLog(`cache ready ${item.id}`);
  }

  async function runOnce({ force = false } = {}) {
    if (running) return snapshot();
    running = true;
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      for (const item of wanted()) {
        if (stopped) break;
        try {
          await ensureOne(item, { force });
        } catch (err) {
          status.set(item.id, { ready: false, error: err.message });
          writeLog(`cache error ${item.id} ${err.message}`);
        }
      }
    } finally {
      running = false;
    }
    return snapshot();
  }

  function nightlyDue(now = new Date()) {
    const clock = String(nightlyAt() || "03:17");
    const match = /^(\d{2}):(\d{2})$/.exec(clock);
    if (!match) return false;
    if (now.getHours() !== Number(match[1]) || now.getMinutes() !== Number(match[2])) return false;
    const stamp = now.toISOString().slice(0, 10);
    if (lastNight === stamp) return false;
    lastNight = stamp;
    return true;
  }

  function start() {
    stopped = false;
    const loop = async () => {
      await runOnce().catch((err) => writeLog(`cache error ${err.message}`));
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 30000));
        if (stopped) break;
        const pending = snapshot().some((row) => !row.ready);
        const nightly = nightlyDue();
        if (pending || nightly) {
          await runOnce({ force: nightly }).catch((err) => writeLog(`cache error ${err.message}`));
        }
      }
    };
    loop();
    return { stop() { stopped = true; } };
  }

  return {
    start,
    runOnce,
    snapshot,
    isReady,
    fileFor,
    nightlyDue,
    readyPath: (id) => readyPath(cacheDir, id),
  };
}

module.exports = {
  createClipCache,
  moovBeforeMdat,
  parseProbe,
  probeFile,
  downloadResumable,
  ffmpegBinary,
  readyPath,
};
