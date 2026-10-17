const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { bootPlan } = require("../src/kiosk-boot");
const http = require("http");
const { logStartupFailure, startServer, addrInUseMessage, reportListenError } = require("../src/server");

test("a down server keeps the kiosk open on the waiting screen", () => {
  const plan = bootPlan({ serverReady: false });
  assert.equal(plan.quit, false);
  assert.equal(plan.screen, "waiting");
  assert.equal(plan.retry, true);
  assert.equal(bootPlan({ serverReady: true }).screen, "displays");
  assert.equal(bootPlan({ serverReady: true }).quit, false);
});

test("waiting screen tells the room the server is still starting", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "public", "waiting.html"), "utf8");
  assert.match(html, /Waiting for server/);
  assert.match(html, /Retrying/);
});

test("startup failure is appended to the data dir log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-log-"));
  const err = Object.assign(
    new Error("EPERM: operation not permitted, rename 'C:\\ProgramData\\PinballLand\\state.json.tmp' -> 'C:\\ProgramData\\PinballLand\\state.json'"),
    { code: "EPERM" }
  );
  err.stack = `${err.message}\n    at Store.persist (src/store.js:185)\n    at Store.load (src/store.js:168)`;
  const file = await logStartupFailure(err, path.join(dir, "logs"));
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /EPERM: operation not permitted, rename/);
  assert.match(text, /state\.json\.tmp/);
  assert.match(text, /Store\.persist/);
  const again = await logStartupFailure(err, path.join(dir, "logs"));
  const both = await fs.readFile(again, "utf8");
  assert.equal(both.split("EPERM:").length, 3);
});

test("an occupied port is reported as another server already listening", async () => {
  const holder = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = holder.address();
    const next = http.createServer();
    const err = await new Promise((resolve, reject) => {
      next.once("error", resolve);
      next.listen(port, "127.0.0.1", () => reject(new Error("second listen should fail")));
    });
    assert.equal(err.code, "EADDRINUSE");
    const lines = [];
    reportListenError(err, port, (line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`port ${port}`));
    assert.match(lines[0], /already listening/);
    assert.match(lines[0], /node\.exe/);
    assert.match(addrInUseMessage(3000), /port 3000/);
    assert.match(addrInUseMessage(3000), /Another server is already listening/);
    const quiet = [];
    reportListenError(Object.assign(new Error("nope"), { code: "EACCES" }), 3000, (line) => quiet.push(line));
    assert.deepEqual(quiet, []);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("startServer records a failed load in logs/server.log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-boot-"));
  const previous = process.env.PINBALL_DATA_DIR;
  process.env.PINBALL_DATA_DIR = dir;
  try {
    await fs.mkdir(path.join(dir, "state.json"));
    await assert.rejects(() => startServer());
    const text = await fs.readFile(path.join(dir, "logs", "server.log"), "utf8");
    assert.match(text, /state\.json/);
    assert.ok(text.trim().length > 0);
  } finally {
    if (previous === undefined) delete process.env.PINBALL_DATA_DIR;
    else process.env.PINBALL_DATA_DIR = previous;
  }
});
