const fs = require("fs");
const path = require("path");

const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".ogg": "video/ogg",
};

const MAX_RANGE_BYTES = 4 * 1024 * 1024;

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveByteRange(header, size, maxBytes = MAX_RANGE_BYTES) {
  const total = Math.max(0, Number(size) || 0);
  const max = Math.max(1, Number(maxBytes) || MAX_RANGE_BYTES);
  if (!header) {
    if (total === 0) return { status: 200, start: 0, end: -1, length: 0 };
    return { status: 200, start: 0, end: total - 1, length: total };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === "" && match[2] === "")) return { status: 416 };
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return { status: 416 };
    const length = Math.min(suffix, max, total);
    if (!length) return { status: 416 };
    start = total - length;
    end = total - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] === "" ? total - 1 : Number.parseInt(match[2], 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || end < start) {
    return { status: 416 };
  }
  end = Math.min(end, total - 1);
  if (end - start + 1 > max) end = start + max - 1;
  return { status: 206, start, end, length: end - start + 1, capped: end - start + 1 === max && end < total - 1 };
}

function destroyStream(stream) {
  if (stream && !stream.destroyed) stream.destroy();
}

function pipeFile(req, res, filePath, start, end, options = {}) {
  const stream = fs.createReadStream(filePath, { start, end });
  if (typeof options.onStream === "function") options.onStream(stream);
  let closed = false;
  const destroy = () => {
    if (closed) return;
    closed = true;
    destroyStream(stream);
  };
  req.on("aborted", destroy);
  req.on("close", () => {
    if (!req.complete) destroy();
  });
  res.on("close", destroy);
  stream.on("error", () => {
    destroy();
    if (!res.headersSent) res.statusCode = 500;
    if (!res.writableEnded) res.destroy();
  });
  res.on("error", destroy);
  stream.pipe(res);
}

function sendByteRange(req, res, filePath, options = {}) {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const mime = mimeFor(filePath);
  const maxBytes = options.maxBytes || MAX_RANGE_BYTES;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, Content-Type");
  const range = resolveByteRange(req.headers.range, size, maxBytes);
  if (range.status === 416) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }
  res.statusCode = range.status;
  res.setHeader("Content-Length", range.length);
  if (range.status === 206) res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  if (req.method === "HEAD" || range.length === 0) {
    res.end();
    return;
  }
  pipeFile(req, res, filePath, range.start, range.end, options);
}

function createMediaTracker({ log, starvedAt = 6 } = {}) {
  let open = 0;
  let maxOpen = 0;
  let longestMs = 0;
  let lastStarved = 0;
  let lastCount = 0;
  return {
    count() {
      return open;
    },
    maxOpen() {
      return maxOpen;
    },
    longestMs() {
      return longestMs;
    },
    serve(req, res, filePath) {
      sendByteRange(req, res, filePath, {
        onStream(stream) {
          const started = Date.now();
          open += 1;
          if (open > maxOpen) maxOpen = open;
          const count = open;
          if (typeof log === "function") {
            const url = String(req.originalUrl || req.url || "").slice(0, 180);
            const range = String(req.headers.range || "");
            if (count >= starvedAt && started - lastStarved >= 1000) {
              lastStarved = started;
              log(`${new Date(started).toISOString()} event=pool-starved openMedia=${count} range=${JSON.stringify(range)} url=${url}`);
            } else if (started - lastCount >= 10000) {
              lastCount = started;
              log(`${new Date(started).toISOString()} event=media-count openMedia=${count} url=${url}`);
            }
          }
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            open = Math.max(0, open - 1);
            const elapsed = Date.now() - started;
            if (elapsed > longestMs) longestMs = elapsed;
          };
          res.on("close", finish);
          stream.on("close", finish);
        },
      });
    },
  };
}

module.exports = {
  MAX_RANGE_BYTES,
  sendByteRange,
  mimeFor,
  resolveByteRange,
  createMediaTracker,
};
