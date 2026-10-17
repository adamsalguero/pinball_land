const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { Store, replaceFile, removeStaleTemp } = require("../src/store");

let filePath;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-land-"));
  filePath = path.join(dir, "state.json");
});

test("seeds a Halloween board, rotation on, and three slots on first load", async () => {
  const store = await Store.load(filePath);
  const state = store.getState();
  assert.equal(state.leaderboards[0].name, "Halloween party");
  assert.equal(state.leaderboards[0].kind, "event");
  assert.equal(state.leaderboards[0].inRotation, true);
  assert.equal(state.rotation.enabled, true);
  assert.equal(state.blackout, false);
  assert.equal(state.slots["1"].content, "pinnacle");
  assert.equal(state.slots["2"].content, "pinball-land");
  assert.equal(state.slots["3"].content, "leaderboard");
  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(saved.leaderboards[0].rows.length, 3);
});

test("assigns a slot, edits rows, and reloads from disk", async () => {
  const store = await Store.load(filePath);
  const boardId = store.getState().leaderboards[0].id;

  await store.setSlot("1", { content: "leaderboard", leaderboardId: boardId });
  await store.addRow(boardId, { name: "Alex", score: "12000" });
  const added = store.getState().leaderboards[0].rows.at(-1);
  await store.updateRow(boardId, added.id, { name: "Alex P", score: 12500 });
  await store.moveRow(boardId, added.id, "up");

  const reloaded = await Store.load(filePath);
  const board = reloaded.getState().leaderboards[0];
  const names = board.rows.map((row) => row.name);
  assert.equal(reloaded.getState().slots["1"].content, "leaderboard");
  assert.ok(names.includes("Alex P"));
  assert.equal(board.rows.find((row) => row.name === "Alex P").score, 12500);
});

test("clear board and black-all persist without wiping slot assignments", async () => {
  const store = await Store.load(filePath);
  const boardId = store.getState().leaderboards[0].id;
  await store.clearLeaderboard(boardId);
  await store.blackAll();
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().leaderboards[0].rows.length, 0);
  assert.equal(reloaded.getState().blackout, true);
  assert.equal(reloaded.getState().slots["1"].content, "pinnacle");
  await reloaded.resumeWall();
  assert.equal(reloaded.getState().blackout, false);
});

test("migrates legacy photo slots and persists halloween theme", async () => {
  await fs.writeFile(
    filePath,
    JSON.stringify({
      theme: "halloween",
      slots: {
        1: { content: "arcade" },
        2: { content: "pool" },
        3: { content: "bar" },
      },
      leaderboards: [{ id: "evt1", name: "Keep me", rows: [] }],
    })
  );
  const store = await Store.load(filePath);
  const state = store.getState();
  assert.equal(state.theme, "halloween");
  assert.equal(state.rotation.enabled, true);
  assert.equal(state.slots["1"].content, "amenity-arcade");
  assert.equal(state.slots["2"].content, "amenity-oasis");
  assert.equal(state.slots["3"].content, "amenity-oasis");
  assert.equal(state.leaderboards[0].name, "Keep me");
  assert.equal(state.leaderboards[0].inRotation, true);
  await store.setTheme("pinnacle");
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().theme, "pinnacle");
});

test("assigns an Outdoor Oasis amenity slot and reloads", async () => {
  const store = await Store.load(filePath);
  await store.setSlot("2", { content: "amenity-oasis" });
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().slots["2"].content, "amenity-oasis");
});

test("machine boards can be added and toggled in the rotation", async () => {
  const store = await Store.load(filePath);
  await store.createLeaderboard("Medieval Madness", {
    kind: "machine",
    opdbId: "GTEST-M1",
    manufacturer: "Williams",
    year: "1997",
    inRotation: true,
  });
  const machine = store.getState().leaderboards.at(-1);
  assert.equal(machine.kind, "machine");
  assert.equal(machine.inRotation, true);
  assert.equal(machine.opdbId, "GTEST-M1");
  await store.updateLeaderboard(machine.id, { inRotation: false });
  const reloaded = await Store.load(filePath);
  const saved = reloaded.getState().leaderboards.find((board) => board.id === machine.id);
  assert.equal(saved.inRotation, false);
  assert.equal(saved.kind, "machine");
});

test("turning rotation on clears blackout", async () => {
  const store = await Store.load(filePath);
  await store.blackAll();
  await store.setRotation({ enabled: true, intervalSec: 12 });
  const state = store.getState();
  assert.equal(state.blackout, false);
  assert.equal(state.rotation.enabled, true);
  assert.equal(state.rotation.intervalSec, 12);
});

function locked(code) {
  return Object.assign(new Error(code), { code });
}

test("load removes a stale temp file and keeps the saved state", async () => {
  const store = await Store.load(filePath);
  await store.setTheme("halloween");
  await fs.writeFile(`${filePath}.tmp`, "{not json");
  const reloaded = await Store.load(filePath);
  let missing = false;
  try {
    await fs.stat(`${filePath}.tmp`);
  } catch (err) {
    missing = err.code === "ENOENT";
  }
  assert.equal(missing, true);
  assert.equal(reloaded.getState().theme, "halloween");
  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(saved.theme, "halloween");
});

test("rename retries EPERM, EBUSY, and EACCES, then succeeds", async () => {
  const codes = ["EPERM", "EBUSY", "EACCES"];
  let renames = 0;
  const sleeps = [];
  const fake = {
    async rename() {
      if (renames < codes.length) {
        const code = codes[renames];
        renames += 1;
        throw locked(code);
      }
      renames += 1;
    },
    async copyFile() {
      throw new Error("copy should not run");
    },
    async unlink() {
      throw new Error("unlink should not run");
    },
  };
  await replaceFile("state.json.tmp", "state.json", fake, {
    delays: [5, 5, 5, 5],
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(renames, 4);
  assert.deepEqual(sleeps, [5, 5, 5]);
});

test("locked rename falls back to copyFile and unlink", async () => {
  const calls = [];
  const fake = {
    async rename() {
      calls.push("rename");
      throw locked("EPERM");
    },
    async copyFile(tmp, dest) {
      calls.push(`copy:${tmp}->${dest}`);
    },
    async unlink(tmp) {
      calls.push(`unlink:${tmp}`);
    },
  };
  await replaceFile("C:\\ProgramData\\PinballLand\\state.json.tmp", "C:\\ProgramData\\PinballLand\\state.json", fake, {
    delays: [],
    sleepFn: async () => {
      throw new Error("no backoff when there are no retries");
    },
  });
  assert.deepEqual(calls, [
    "rename",
    "copy:C:\\ProgramData\\PinballLand\\state.json.tmp->C:\\ProgramData\\PinballLand\\state.json",
    "unlink:C:\\ProgramData\\PinballLand\\state.json.tmp",
  ]);
});

test("copy fallback retries a locked destination, and a missing temp after copy is fine", async () => {
  let copies = 0;
  const fake = {
    async rename() {
      throw locked("EBUSY");
    },
    async copyFile() {
      copies += 1;
      if (copies === 1) throw locked("EACCES");
    },
    async unlink() {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
  };
  const sleeps = [];
  await replaceFile("state.json.tmp", "state.json", fake, {
    delays: [0],
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(copies, 2);
  assert.deepEqual(sleeps, [0, 0]);
});

test("unrelated rename errors are not retried and do not copy", async () => {
  let copies = 0;
  const fake = {
    async rename() {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async copyFile() {
      copies += 1;
    },
    async unlink() {},
  };
  await assert.rejects(
    () => replaceFile("state.json.tmp", "state.json", fake, { delays: [0, 0], sleepFn: async () => {} }),
    (err) => err.code === "ENOENT"
  );
  assert.equal(copies, 0);
});

test("a stale temp that cannot be removed does not block load", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await removeStaleTemp(filePath, {
      async unlink() {
        throw locked("EPERM");
      },
    });
  } finally {
    console.warn = original;
  }
  assert.match(warnings.join("\n"), /stale temp file/);
  const store = await Store.load(filePath);
  assert.equal(store.getState().theme, "pinnacle");
});

test("delete and reorder rows", async () => {
  const store = await Store.load(filePath);
  const boardId = store.getState().leaderboards[0].id;
  const first = store.getState().leaderboards[0].rows[0];
  await store.deleteRow(boardId, first.id);
  assert.equal(store.getState().leaderboards[0].rows.length, 2);
  const [a, b] = store.getState().leaderboards[0].rows;
  await store.moveRow(boardId, b.id, "up");
  assert.equal(store.getState().leaderboards[0].rows[0].id, b.id);
  assert.equal(store.getState().leaderboards[0].rows[1].id, a.id);
});
