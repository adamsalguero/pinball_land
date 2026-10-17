const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { sendByteRange } = require("../src/media-range");
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
