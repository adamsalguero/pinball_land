const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { purgeRemovedStarters, removedStarterId } = require("./catalog");

const TRANSCODE_MARK = "pinball-transcode-v1";
const TRANSCODE_FILTER = "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30";

function ffmpegBinary() {
  try {
    const bundled = require("ffmpeg-static");
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // The system ffmpeg is only a fallback when the package binary is missing.
  }
  return "ffmpeg";
}

function runProcess(bin, args, timeoutMs = 15 * 60 * 1000, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (options.lowPriority && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
      } catch {
        // Priority is a courtesy. The transcode still runs one file at a time.
      }
    }
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
  const text = String(stderr || "");
  const video = /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Video: ([A-Za-z0-9_]+)(?: \(([^)]+)\))?[^\n]*?,\s*(yuv[a-z0-9]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(text);
  const fps = /(\d+(?:\.\d+)?) fps/.exec(text);
  const audio = /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Audio: ([A-Za-z0-9_]+)(?: \(([^)]+)\))?/.exec(text);
  const title = /\btitle\s*:\s*(.+)/i.exec(text);
  const comment = /\bcomment\s*:\s*(.+)/i.exec(text);
  const rate = Number(fps?.[1]) || 0;
  return {
    videoCodec: (video?.[1] || "").toLowerCase(),
    profile: (video?.[2] || "").toLowerCase(),
    pixFmt: (video?.[3] || "").toLowerCase(),
    width: Number(video?.[4]) || 0,
    height: Number(video?.[5]) || 0,
    fps: rate,
    audioCodec: (audio?.[1] || "").toLowerCase(),
    audioProfile: (audio?.[2] || "").toLowerCase(),
    title: title ? title[1].trim() : "",
    comment: comment ? comment[1].trim() : "",
  };
}

async function probeFile(ffmpeg, file) {
  const result = await runProcess(ffmpeg, ["-hide_banner", "-i", file]);
  const info = parseProbe(result.stderr);
  info.faststart = await moovBeforeMdat(file);
  const audioOk = !info.audioCodec || (info.audioCodec === "aac" && !info.audioProfile.includes("he"));
  info.playable = info.comment === TRANSCODE_MARK
    && info.videoCodec === "h264"
    && (info.profile === "high" || info.profile === "main")
    && info.pixFmt === "yuv420p"
    && Math.round(info.fps) === 30
    && info.width > 0
    && info.height > 0
    && info.width <= 1920
    && info.height <= 1080
    && audioOk
    && info.faststart;
  return info;
}

function metadataValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").slice(0, 180);
}

async function transcodeFile(ffmpeg, source, dest, title, profile = "high", hasAudio = true) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", source,
    "-map", "0:v:0",
  ];
  if (hasAudio) args.push("-map", "0:a:0?");
  args.push(
    "-vf", TRANSCODE_FILTER,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-profile:v", profile,
    "-level", "4.0",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-fps_mode", "cfr",
    "-g", "60",
    "-keyint_min", "60",
    "-sc_threshold", "0",
  );
  if (hasAudio) {
    args.push("-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  } else {
    args.push("-an");
  }
  args.push(
    "-movflags", "+faststart",
    "-metadata", `title=${metadataValue(title)}`,
    "-metadata", `comment=${TRANSCODE_MARK}`,
    dest,
  );
  const result = await runProcess(ffmpeg, args, 15 * 60 * 1000, { lowPriority: true });
  if (result.code !== 0) {
    const tail = result.stderr.split("\n").filter(Boolean).slice(-3).join(" ");
    throw new Error(tail || `ffmpeg ${profile} failed`);
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
  const wanted = () => (items || []).filter((item) => item?.id && item.streamUrl && !removedStarterId(item.id) && (!allow || allow.has(item.id)));
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

  async function publishTranscode(source, dest, title) {
    const tmp = `${dest}.transcode.mp4`;
    await fsp.rm(tmp, { force: true }).catch(() => {});
    const sourceInfo = await probeFile(ffmpeg, source).catch(() => ({}));
    const hasAudio = Boolean(sourceInfo.audioCodec);
    const label = sourceInfo.title || title;
    try {
      try {
        await transcodeFile(ffmpeg, source, tmp, label, "high", hasAudio);
      } catch (err) {
        await transcodeFile(ffmpeg, source, tmp, label, "main", hasAudio);
        writeLog(`cache transcode profile=main after ${err.message}`);
      }
      const checked = await probeFile(ffmpeg, tmp);
      if (!checked.playable) {
        throw new Error(`transcode is not playable (${checked.videoCodec} ${checked.profile} ${checked.pixFmt} ${checked.fps}fps mark=${checked.comment} moov=${checked.faststart})`);
      }
      await fsp.rm(dest, { force: true }).catch(() => {});
      await fsp.rename(tmp, dest);
      return checked;
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function ensureOne(item, { force = false } = {}) {
    if (removedStarterId(item.id)) return;
    const finalFile = readyPath(cacheDir, item.id);
    const part = `${finalFile}.part`;
    if (!force && status.get(item.id)?.ready && fs.existsSync(finalFile)) return;
    if (fs.existsSync(finalFile)) {
      const info = await probeFile(ffmpeg, finalFile);
      if (info.playable) {
        status.set(item.id, { ready: true, error: null });
        return;
      }
      status.set(item.id, { ready: false, error: null });
      writeLog(`cache migrate ${item.id}`);
      const checked = await publishTranscode(finalFile, finalFile, info.title || item.title || item.id);
      const size = (await fsp.stat(finalFile)).size;
      status.set(item.id, { ready: true, error: null });
      writeLog(`cache transcode ${item.id} ok bytes=${size} profile=${checked.profile} fps=${checked.fps}`);
      return;
    }
    status.set(item.id, { ready: false, error: null });
    writeLog(`cache start ${item.id}`);
    await downloadResumable(item.streamUrl, part, fetchImpl);
    const checked = await publishTranscode(part, finalFile, item.title || item.id);
    await fsp.unlink(part).catch(() => {});
    const size = (await fsp.stat(finalFile)).size;
    status.set(item.id, { ready: true, error: null });
    writeLog(`cache transcode ${item.id} ok bytes=${size} profile=${checked.profile} fps=${checked.fps}`);
  }

  async function runOnce({ force = false } = {}) {
    if (running) return snapshot();
    running = true;
    try {
      purgeRemovedStarters(cacheDir);
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
  TRANSCODE_MARK,
  transcodeFile,
};
