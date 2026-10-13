const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { Presentations, normalizeHttpUrl, FAILURE_LIMIT } = require("../src/presentations");
const { createConfigStore } = require("../src/config");
const { resolveAirplayCommand, buildAirplayArgs, buildPlacementScript, AirplayController } = require("../src/airplay");
const { isLanAddress, isLoopback } = require("../src/lan");
const { buildSanConfig, ensureCertificate } = require("../src/certs");

test("normalizeHttpUrl allows http(s) only", () => {
  assert.equal(normalizeHttpUrl("https://example.com/slides"), "https://example.com/slides");
  assert.equal(normalizeHttpUrl("javascript:alert(1)"), null);
  assert.equal(normalizeHttpUrl("file:///tmp/secret.pdf"), null);
  assert.equal(normalizeHttpUrl("not a url"), null);
});

test("presentation idle timeout ends one screen and leaves the others", async () => {
  let now = 1_000_000;
  const presentations = new Presentations({ idleMinutes: 10, now: () => now });
  const web = await presentations.start({ slot: "1", source: "webrtc" });
  await presentations.start({ slot: "2", source: "url", url: "https://example.com" });
  assert.equal(web.code.length, 4);
  assert.equal(presentations.publicState()["1"].token, undefined);
  now += 9 * 60 * 1000;
  assert.equal((await presentations.endExpired(now)).length, 0);
  presentations.touch(web.id, now);
  now += 2 * 60 * 1000;
  const ended = await presentations.endExpired(now);
  assert.deepEqual(ended.map((session) => session.slot), ["2"]);
  assert.equal(presentations.get("1").id, web.id);
  assert.equal(presentations.get("2"), null);
});

test("share code join is rate limited and does not leak the token on failure", () => {
  const presentations = new Presentations({ now: () => 0 });
  let now = 0;
  for (let i = 0; i < FAILURE_LIMIT; i += 1) {
    const failed = presentations.join({ code: "0000", ip: "192.168.1.9", now });
    assert.equal(failed.status, 401);
    assert.equal(failed.token, undefined);
  }
  const blocked = presentations.join({ code: "0000", ip: "192.168.1.9", now });
  assert.equal(blocked.status, 429);
});

test("display config and idle minutes persist in config.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-config-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ port: 3000, pin: "1234", note: "keep" }));
  const store = createConfigStore(configPath);
  await store.update({
    displays: {
      count: 2,
      mirror: true,
      order: ["mon-b", "mon-a"],
      screens: { 2: { enabled: false, content: "amenity-oasis" } },
    },
    presentation: { idleMinutes: 25 },
  });
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.note, "keep");
  assert.equal(saved.pin, "1234");
  assert.equal(saved.displays.count, 2);
  assert.equal(saved.displays.mirror, true);
  assert.equal(saved.displays.screens["2"].enabled, false);
  assert.equal(saved.displays.screens["1"].content, "rotation");
  assert.deepEqual(saved.displays.order, ["mon-b", "mon-a"]);
  assert.equal(saved.presentation.idleMinutes, 25);
  const loaded = createConfigStore(configPath).get();
  assert.equal(loaded.displays.count, 2);
  assert.equal(loaded.presentation.idleMinutes, 25);
});

test("airplay command resolution and window placement script", () => {
  const missing = resolveAirplayCommand({
    root: "/tmp/pinball-missing",
    exists: () => false,
    platform: "win32",
  });
  assert.equal(missing.ok, false);

  const found = resolveAirplayCommand({
    root: "C:\\pinball-land",
    exists: (candidate) => candidate.endsWith(`${path.sep}tools${path.sep}uxplay.exe`),
    platform: "win32",
  });
  assert.equal(found.ok, true);
  assert.match(found.command, /uxplay\.exe$/);

  const args = buildAirplayArgs({
    windowTitle: "Pinball Land",
    bounds: { width: 1920, height: 1080 },
    platform: "win32",
    extraArgs: ["-dacp"],
  });
  assert.deepEqual(args.slice(0, 4), ["-n", "Pinball Land", "-nh", "-s"]);
  assert.ok(args.includes("1920x1080"));
  assert.ok(args.includes("d3d11videosink"));
  assert.ok(args.includes("-dacp"));
  assert.equal(args.includes("-fs"), false);

  const script = buildPlacementScript({ pid: 4242, bounds: { x: 1920, y: 0, width: 1280, height: 720 } });
  assert.match(script, /\$target = 4242/);
  assert.match(script, /\$x = 1920/);
  assert.match(script, /1280/);
  assert.match(script, /PLACED/);
  assert.match(script, /WAITING/);
  assert.equal(buildPlacementScript({ pid: 0, bounds: { width: 10, height: 10 } }).includes("PLACED"), false);
});

test("airplay controller does not spawn when the helper is missing and can be stopped", () => {
  const calls = [];
  const controller = new AirplayController({
    platform: "linux",
    root: "/nowhere",
    exists: () => false,
    getAirplayConfig: () => ({ command: "", args: [], windowTitle: "Pinball Land" }),
    spawnImpl(command, args) {
      calls.push([command, args]);
      const child = new EventEmitter();
      child.pid = 77;
      child.kill = () => child.emit("exit", 0);
      return child;
    },
  });
  const missing = controller.start({ slot: "2", bounds: { width: 1920, height: 1080 } });
  assert.equal(missing.ok, false);
  assert.equal(calls.length, 0);

  const ready = new AirplayController({
    platform: "win32",
    root: "C:\\pinball-land",
    exists: () => true,
    getAirplayConfig: () => ({ command: "C:\\pinball-land\\tools\\uxplay.exe", args: [], windowTitle: "Pinball Land" }),
    spawnImpl(command, args) {
      calls.push([command, args]);
      const child = new EventEmitter();
      child.pid = 88;
      child.kill = () => child.emit("exit", 0);
      return child;
    },
  });
  const started = ready.start({ slot: "1", bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
  assert.equal(started.ok, true);
  assert.equal(started.pid, 88);
  ready.stop();
  assert.equal(calls.at(-1)[0], "taskkill");
});

test("LAN check allows the venue network and rejects public addresses", () => {
  assert.equal(isLanAddress("127.0.0.1"), true);
  assert.equal(isLanAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLanAddress("::1"), true);
  assert.equal(isLanAddress("192.168.1.40"), true);
  assert.equal(isLanAddress("10.1.2.3"), true);
  assert.equal(isLanAddress("172.16.5.5"), true);
  assert.equal(isLanAddress("172.32.5.5"), false);
  assert.equal(isLanAddress("8.8.8.8"), false);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("192.168.1.40"), false);
});

test("certificate config lists the LAN address as a SAN", () => {
  const cnf = buildSanConfig(["localhost", "192.168.1.42"]);
  assert.match(cnf, /DNS:localhost/);
  assert.match(cnf, /IP:127\.0\.0\.1/);
  assert.match(cnf, /IP:192\.168\.1\.42/);
});

test("a local certificate is created and reused for browser share", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-cert-"));
  const first = await ensureCertificate({ certDir: dir, hosts: ["localhost", "192.168.1.42"] });
  assert.equal(first.created, true);
  const cert = await fs.readFile(first.certPath, "utf8");
  assert.match(cert, /BEGIN CERTIFICATE/);
  const second = await ensureCertificate({ certDir: dir, hosts: ["192.168.1.42", "localhost"] });
  assert.equal(second.created, false);
});
