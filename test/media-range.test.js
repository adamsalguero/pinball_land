const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { sendByteRange, resolveByteRange, createMediaTracker, MAX_RANGE_BYTES } = require("../src/media-range");
const { loadConfig } = require("../src/config");
const { BUILTIN_OPDB_API_KEY } = require("../src/opdb");

test("local media answers HTTP 206 for a byte range", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinball-range-"));
  const file = path.join(dir, "clip.mp4");
  const body = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  fs.writeFileSync(file, body);
  const server = http.createServer((req, res) => sendByteRange(req, res, file));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/clip.mp4`, { headers: { Range: "bytes=4-8" } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 4-8/${body.length}`);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "45678");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("open-ended ranges are capped at 4 MB with a matching Content-Range", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinball-range-"));
  const file = path.join(dir, "clip.mp4");
  const size = MAX_RANGE_BYTES + 80;
  const body = Buffer.alloc(size, 0);
  body[0] = 7;
  body[MAX_RANGE_BYTES] = 9;
  fs.writeFileSync(file, body);
  const server = http.createServer((req, res) => sendByteRange(req, res, file));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const open = await fetch(`http://127.0.0.1:${port}/clip.mp4`, { headers: { Range: "bytes=0-" } });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get("content-range"), `bytes 0-${MAX_RANGE_BYTES - 1}/${size}`);
    assert.equal(open.headers.get("content-length"), String(MAX_RANGE_BYTES));
    const chunk = Buffer.from(await open.arrayBuffer());
    assert.equal(chunk.length, MAX_RANGE_BYTES);
    assert.equal(chunk[0], 7);
    const rest = await fetch(`http://127.0.0.1:${port}/clip.mp4`, { headers: { Range: `bytes=${MAX_RANGE_BYTES}-` } });
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get("content-range"), `bytes ${MAX_RANGE_BYTES}-${size - 1}/${size}`);
    assert.equal(rest.headers.get("content-length"), "80");
    assert.equal(Buffer.from(await rest.arrayBuffer())[0], 9);
    const whole = await fetch(`http://127.0.0.1:${port}/clip.mp4`);
    assert.equal(whole.status, 206);
    assert.equal(whole.headers.get("content-length"), String(MAX_RANGE_BYTES));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a range larger than the cap is shortened and a suffix range stays exact", () => {
  const size = 1000;
  const capped = resolveByteRange("bytes=10-900", size, 100);
  assert.equal(capped.status, 206);
  assert.equal(capped.start, 10);
  assert.equal(capped.end, 109);
  assert.equal(capped.length, 100);
  const suffix = resolveByteRange("bytes=-25", size, 100);
  assert.equal(suffix.start, 975);
  assert.equal(suffix.end, 999);
  assert.equal(suffix.length, 25);
  assert.equal(resolveByteRange("bytes=-", size).status, 416);
});

test("an aborted media response destroys the file stream", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinball-range-"));
  const file = path.join(dir, "clip.mp4");
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 4));
  let stream = null;
  const server = http.createServer((req, res) => {
    sendByteRange(req, res, file, {
      onStream(created) { stream = created; },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: "127.0.0.1",
        port,
        path: "/clip.mp4",
        headers: { Range: "bytes=0-" },
      }, (res) => {
        assert.equal(res.statusCode, 206);
        res.pause();
        setTimeout(() => {
          req.destroy();
          setTimeout(() => {
            try {
              assert.ok(stream);
              assert.equal(stream.destroyed, true);
              resolve();
            } catch (err) {
              reject(err);
            }
          }, 80);
        }, 40);
      });
      req.on("error", () => {});
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("open media responses are counted and a full pool logs pool-starved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinball-range-"));
  const file = path.join(dir, "clip.mp4");
  fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 2));
  const lines = [];
  const tracker = createMediaTracker({ log: (line) => lines.push(line), starvedAt: 2 });
  const server = http.createServer((req, res) => tracker.serve(req, res, file));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const requests = [];
  try {
    await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
      const req = http.get({
        hostname: "127.0.0.1",
        port,
        path: "/media/cache/clip",
        headers: { Range: "bytes=0-" },
      }, (res) => {
        res.pause();
        requests.push(req);
        resolve();
      });
      req.on("error", reject);
    })));
    assert.equal(tracker.count(), 2);
    assert.match(lines.join("\n"), /event=pool-starved openMedia=2/);
    for (const req of requests) req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(tracker.count(), 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an empty OPDB key uses the built-in token and config overrides it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinball-opdb-"));
  const emptyPath = path.join(dir, "empty.json");
  fs.writeFileSync(emptyPath, JSON.stringify({ opdbApiKey: "", pin: "2224" }));
  const previous = process.env.OPDB_API_KEY;
  delete process.env.OPDB_API_KEY;
  try {
    assert.equal(loadConfig(emptyPath).opdbApiKey, BUILTIN_OPDB_API_KEY);
    const customPath = path.join(dir, "custom.json");
    fs.writeFileSync(customPath, JSON.stringify({ opdbApiKey: "venue-token", pin: "2224" }));
    assert.equal(loadConfig(customPath).opdbApiKey, "venue-token");
    process.env.OPDB_API_KEY = "from-env";
    assert.equal(loadConfig(customPath).opdbApiKey, "from-env");
  } finally {
    if (previous === undefined) delete process.env.OPDB_API_KEY;
    else process.env.OPDB_API_KEY = previous;
  }
});
