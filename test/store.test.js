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

test("starts with machine boards only, rotation on, and a 30s dwell", async () => {
  const store = await Store.load(filePath);
  const state = store.getState();
  assert.equal(state.leaderboards.length, 0);
  assert.equal(state.rotation.enabled, true);
  assert.equal(state.blackout, false);
  assert.equal(state.slots["1"].content, "logos");
  assert.equal(state.slots["2"].content, "amenities");
  assert.equal(state.slots["3"].content, "leaderboard");
  assert.equal(state.rotation.intervalSec, 30);
});

async function addMachine(store, name = "Medieval Madness") {
  await store.createLeaderboard(name, { kind: "machine", opdbId: "GTEST-M1", manufacturer: "Williams", year: "1997" });
  return store.getState().leaderboards.at(-1).id;
}

test("comma scores load as numbers and sort 50, 200, 5000, 6000, 500000000", async () => {
  await fs.writeFile(filePath, JSON.stringify({
    leaderboards: [{
      id: "oz",
      name: "The Wizard of Oz",
      kind: "machine",
      opdbId: "OZ-1",
      rows: [
        { id: "a", name: "RetroHardroc", score: "50" },
        { id: "b", name: "John Smith", score: "200" },
        { id: "c", name: "Montgomery Alexander-Parra", score: "5,000" },
        { id: "d", name: "Adam Salguero", score: "6,000" },
        { id: "e", name: "Alexander Montgomery-Parra", score: "500,000,000" },
      ],
    }],
  }));
  const store = await Store.load(filePath);
  const scores = store.getState().leaderboards[0].rows.map((row) => row.score);
  assert.deepEqual(scores, [500000000, 6000, 5000, 200, 50]);
  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(saved.leaderboards[0].rows.map((row) => row.score), [500000000, 6000, 5000, 200, 50]);
  assert.ok(saved.leaderboards[0].rows.every((row) => typeof row.score === "number"));
});

test("assigns a slot, sorts scores, and reloads from disk", async () => {
  const store = await Store.load(filePath);
  const boardId = await addMachine(store);

  await store.setSlot("1", { content: "leaderboard", leaderboardId: boardId });
  await store.addRow(boardId, { name: "Alex", score: "12000" });
  await store.addRow(boardId, { name: "Sam", score: "40000" });
  const added = store.getState().leaderboards[0].rows.find((row) => row.name === "Alex");
  await store.updateRow(boardId, added.id, { name: "Alex P", score: 12500 });

  const reloaded = await Store.load(filePath);
  const board = reloaded.getState().leaderboards[0];
  assert.equal(reloaded.getState().slots["1"].content, "leaderboard");
  assert.deepEqual(board.rows.map((row) => row.name), ["Sam", "Alex P"]);
  assert.equal(board.rows.find((row) => row.name === "Alex P").score, 12500);
});

test("clear board keeps slot assignments and black does not blank the wall", async () => {
  const store = await Store.load(filePath);
  const boardId = await addMachine(store);
  await store.clearLeaderboard(boardId);
  await store.blackAll();
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().leaderboards[0].rows.length, 0);
  assert.equal(reloaded.getState().blackout, false);
  assert.equal(reloaded.getState().rotation.enabled, true);
  assert.equal(reloaded.getState().slots["1"].content, "logos");
});

test("a saved black wall loads as rotation", async () => {
  await fs.writeFile(
    filePath,
    JSON.stringify({
      blackout: true,
      rotation: { enabled: false, intervalSec: 14 },
      slots: {
        1: { content: "dark" },
        2: { content: "black" },
        3: { content: "off" },
      },
    })
  );
  const state = (await Store.load(filePath)).getState();
  assert.equal(state.blackout, false);
  assert.equal(state.rotation.enabled, true);
  assert.equal(state.rotation.intervalSec, 30);
  assert.equal(state.slots["1"].content, "logos");
  assert.equal(state.slots["2"].content, "logos");
  assert.equal(state.slots["3"].content, "logos");
});

test("migrates legacy photo slots and persists halloween theme", async () => {
  await fs.writeFile(
    filePath,
    JSON.stringify({
      theme: "halloween",
      slots: {
        1: { content: "photos" },
        2: { content: "pool" },
        3: { content: "amenity-arcade" },
      },
      leaderboards: [{ id: "evt1", name: "Keep me", rows: [] }],
    })
  );
  const store = await Store.load(filePath);
  const state = store.getState();
  assert.equal(state.theme, "halloween");
  assert.equal(state.rotation.enabled, true);
  assert.equal(state.slots["1"].content, "pinboard");
  assert.equal(state.slots["2"].content, "amenities");
  assert.equal(state.slots["3"].content, "amenities");
  assert.equal(state.leaderboards.length, 0);
  assert.equal(state.archivedLeaderboards[0].name, "Keep me");
  await store.setTheme("pinnacle");
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().theme, "pinnacle");
});

test("assigns an Outdoor Oasis amenity slot and reloads", async () => {
  const store = await Store.load(filePath);
  await store.setSlot("2", { content: "amenity-oasis" });
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().slots["2"].content, "amenities");
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

test("a read-only destination is cleared before the replace is retried", async () => {
  const calls = [];
  let mode = 0o444;
  const fake = {
    async stat() {
      return { mode };
    },
    async chmod(_dest, next) {
      mode = next;
      calls.push(`chmod:${mode.toString(8)}`);
    },
    async rename() {
      calls.push(`rename:${mode.toString(8)}`);
      if ((mode & 0o200) === 0) throw locked("EPERM");
    },
    async copyFile() {
      throw new Error("copy should not run");
    },
    async unlink() {
      throw new Error("unlink should not run");
    },
  };
  await replaceFile("state.json.tmp", "state.json", fake, {
    delays: [0],
    sleepFn: async () => {
      calls.push("sleep");
    },
  });
  assert.equal(mode & 0o200, 0o200);
  assert.deepEqual(calls, ["chmod:644", "rename:644"]);
});

test("rename and copyFile EPERM fall back to a direct fsync write", async () => {
  const calls = [];
  const fake = {
    async stat() {
      return { mode: 0o666 };
    },
    async chmod() {
      throw new Error("chmod should not run when the file is already writable");
    },
    async rename() {
      calls.push("rename");
      throw locked("EPERM");
    },
    async copyFile() {
      calls.push("copy");
      throw locked("EPERM");
    },
    async readFile() {
      calls.push("read");
      return "{\"theme\":\"halloween\"}";
    },
    async open(dest) {
      calls.push(`open:${dest}`);
      return {
        async writeFile(data) {
          calls.push(`write:${data}`);
        },
        async sync() {
          calls.push("sync");
        },
        async close() {
          calls.push("close");
        },
      };
    },
    async unlink(tmp) {
      calls.push(`unlink:${tmp}`);
    },
  };
  await replaceFile(
    "C:\\ProgramData\\PinballLand\\state.json.tmp",
    "C:\\ProgramData\\PinballLand\\state.json",
    fake,
    {
      delays: [],
      sleepFn: async () => {
        throw new Error("no backoff when there are no retries");
      },
    }
  );
  assert.deepEqual(calls, [
    "rename",
    "copy",
    "read",
    "open:C:\\ProgramData\\PinballLand\\state.json",
    "write:{\"theme\":\"halloween\"}",
    "sync",
    "close",
    "unlink:C:\\ProgramData\\PinballLand\\state.json.tmp",
  ]);
});

test("a locked replace with no direct-write handle still throws EPERM", async () => {
  const fake = {
    async rename() {
      throw locked("EPERM");
    },
    async copyFile() {
      throw locked("EPERM");
    },
    async unlink() {},
  };
  await assert.rejects(
    () => replaceFile("state.json.tmp", "state.json", fake, { delays: [], sleepFn: async () => {} }),
    (err) => err.code === "EPERM" && err.renameError && err.renameError.code === "EPERM"
  );
});

test("load keeps the saved state in memory when every persist attempt is EPERM", async () => {
  const file = "C:\\ProgramData\\PinballLand\\state.json";
  const files = new Map([[file, JSON.stringify({ theme: "halloween" })]]);
  const fake = {
    async mkdir() {},
    async stat() {
      return { mode: 0o666 };
    },
    async readFile(target) {
      if (!files.has(target)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(target);
    },
    async writeFile(target, data) {
      if (String(target).endsWith(".tmp")) {
        files.set(target, data);
        return;
      }
      throw locked("EPERM");
    },
    async rename() {
      throw locked("EPERM");
    },
    async copyFile() {
      throw locked("EPERM");
    },
    async unlink() {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async open() {
      throw locked("EPERM");
    },
  };
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let store;
  try {
    store = await Store.load(file, {
      fsImpl: fake,
      renameDelays: [],
      retryDelays: [60_000],
      sleepFn: async () => {
        throw new Error("no backoff when there are no retries");
      },
    });
    assert.equal(store.unpersisted, true);
    assert.equal(store.getState().theme, "halloween");
    const text = warnings.join("\n");
    assert.match(text, /keep running with this state in memory/);
    assert.match(text, /owned by Administrators/);
    assert.match(text, /read-only attribute/);
    assert.match(text, /another node process/);
    assert.match(text, /antivirus software/);
    assert.ok(text.includes('icacls "C:\\ProgramData\\PinballLand" /grant "Users:(OI)(CI)M" /T /C'));
  } finally {
    console.warn = original;
    if (store) clearTimeout(store.retryTimer);
  }
});

test("a later persist retry writes state.json after the EPERM clears", async () => {
  const file = "C:\\ProgramData\\PinballLand\\state.json";
  const files = new Map([[file, JSON.stringify({ theme: "halloween" })]]);
  let allow = false;
  let synced = false;
  const fake = {
    async mkdir() {},
    async stat() {
      return { mode: 0o666 };
    },
    async readFile(target) {
      if (!files.has(target)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return files.get(target);
    },
    async writeFile(target, data) {
      if (String(target).endsWith(".tmp")) {
        files.set(target, data);
        return;
      }
      throw locked("EPERM");
    },
    async rename() {
      throw locked("EPERM");
    },
    async copyFile() {
      throw locked("EPERM");
    },
    async unlink() {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async open(target) {
      if (!allow) throw locked("EPERM");
      return {
        async writeFile(data) {
          files.set(target, String(data));
        },
        async sync() {
          synced = true;
        },
        async close() {},
      };
    },
  };
  const original = console.warn;
  console.warn = () => {};
  let store;
  try {
    store = await Store.load(file, {
      fsImpl: fake,
      renameDelays: [],
      retryDelays: [20],
      sleepFn: async () => {},
    });
    assert.equal(store.getState().theme, "halloween");
    allow = true;
    const started = Date.now();
    while (store.unpersisted && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(store.unpersisted, false);
    assert.equal(synced, true);
    assert.match(files.get(file), /halloween/);
  } finally {
    console.warn = original;
    if (store) clearTimeout(store.retryTimer);
  }
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

test("delete a score and archive a party board", async () => {
  const store = await Store.load(filePath);
  const boardId = await addMachine(store);
  await store.addRow(boardId, { name: "Low", score: 10 });
  await store.addRow(boardId, { name: "High", score: 90 });
  const low = store.getState().leaderboards[0].rows.find((row) => row.name === "Low");
  await store.deleteRow(boardId, low.id);
  assert.equal(store.getState().leaderboards[0].rows.length, 1);
  await store.archiveLeaderboard(boardId);
  assert.equal(store.getState().leaderboards.length, 0);
  assert.equal(store.getState().archivedLeaderboards[0].name, "Medieval Madness");
  await store.restoreLeaderboard(boardId);
  assert.equal(store.getState().leaderboards[0].rows[0].name, "High");
});

test("approving a guest score updates the matching player", async () => {
  const store = await Store.load(filePath);
  const boardId = await addMachine(store);
  await store.addRow(boardId, { name: "Adam Salguero", score: 1000 });
  const proof = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg";
  const higher = await store.submitScore({
    boardId,
    name: "  adam   salguero ",
    score: "2500",
    proofFile: proof,
    ip: "10.0.0.21",
    now: 5_000,
  });
  await store.reviewScore(higher.id, "approved");
  let rows = store.getState().leaderboards[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Adam Salguero");
  assert.equal(rows[0].score, 2500);
  assert.equal(rows[0].proofFile, proof);
  assert.equal(rows[0].createdAt, 5000);
  const lower = await store.submitScore({
    boardId,
    name: "ADAM SALGUERO",
    score: 900,
    proofFile: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg",
    ip: "10.0.0.22",
    now: 9_000,
  });
  await store.reviewScore(lower.id, "approved");
  rows = store.getState().leaderboards[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 2500);
  assert.equal(rows[0].proofFile, "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg");
  assert.equal(rows[0].showOnWall, true);
  assert.equal(rows[0].createdAt, 9000);
  const secret = await store.submitScore({
    boardId,
    name: "New Player",
    score: 40,
    proofFile: "cccccccc-cccc-4ccc-8ddd-eeeeeeeeeeee.jpg",
    ip: "10.0.0.23",
    now: 12_000,
  });
  await store.reviewScore(secret.id, "approved", { showPhoto: false });
  const hidden = store.getState().leaderboards[0].rows.find((row) => row.name === "New Player");
  assert.equal(hidden.proofFile, "cccccccc-cccc-4ccc-8ddd-eeeeeeeeeeee.jpg");
  assert.equal(hidden.showOnWall, false);
  await store.updateRow(boardId, hidden.id, { showOnWall: true });
  assert.equal(store.getState().leaderboards[0].rows.find((row) => row.id === hidden.id).showOnWall, true);
  await store.updateRow(boardId, hidden.id, { removeProof: true });
  const removed = store.getState().leaderboards[0].rows.find((row) => row.id === hidden.id);
  assert.equal(removed.proofFile, null);
  assert.equal(removed.showOnWall, false);
});

test("auto-approved guest scores post immediately and the default stays pending", async () => {
  const store = await Store.load(filePath);
  const boardId = await addMachine(store);
  const waiting = await store.submitScore({ boardId, name: "Casey", score: "4200", ip: "10.2.0.1", now: 1000 });
  assert.equal(waiting.status, "pending");
  assert.equal(store.getState().leaderboards[0].rows.length, 0);
  const posted = await store.submitScore({
    boardId,
    name: "Drew",
    score: "8800",
    ip: "10.2.0.2",
    now: 2000,
    autoApprove: true,
  });
  assert.equal(posted.status, "approved");
  let rows = store.getState().leaderboards[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Drew");
  assert.equal(rows[0].score, 8800);
  const higher = await store.submitScore({
    boardId,
    name: "drew",
    score: 9000,
    ip: "10.2.0.3",
    now: 3000,
    autoApprove: true,
  });
  assert.equal(higher.status, "approved");
  rows = store.getState().leaderboards[0].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 9000);
  await store.reviewScore(waiting.id, "approved");
  assert.equal(store.getState().leaderboards[0].rows.some((row) => row.name === "Casey"), true);
});

test("guest scores wait for approval and are rate limited", async () => {
  const store = await Store.load(filePath);
  const boardId = await addMachine(store);
  const submitted = await store.submitScore({ boardId, name: "Ava", score: "5000", ip: "10.0.0.8", now: 1_000 });
  assert.equal(submitted.status, "pending");
  assert.equal(store.getState().leaderboards[0].rows.length, 0);
  await store.reviewScore(submitted.id, "approved");
  assert.equal(store.getState().leaderboards[0].rows[0].name, "Ava");
  for (let i = 0; i < 5; i += 1) {
    await store.submitScore({ boardId, name: "Ava", score: i, ip: "10.0.0.8", now: 2_000 + i });
  }
  await assert.rejects(
    () => store.submitScore({ boardId, name: "Ava", score: 9, ip: "10.0.0.8", now: 3_000 }),
    (err) => err.status === 429
  );
});

test("a requested machine stays pending once, and reloads without a board", async () => {
  const store = await Store.load(filePath);
  const first = await store.requestMachineScore({
    opdbId: "GLWll-MXr4N",
    machineName: "JAWS (Pro)",
    manufacturer: "Stern",
    year: "2024",
    edition: "Pro edition",
    name: "Casey",
    score: "4200",
    ip: "10.4.0.1",
    now: 1000,
  });
  const second = await store.requestMachineScore({
    opdbId: "GLWll-MXr4N",
    machineName: "JAWS (Pro)",
    name: "Other",
    score: "50",
    ip: "10.4.0.2",
    now: 2000,
  });
  assert.equal(second.id, first.id);
  const other = await store.requestMachineScore({
    opdbId: "GLWll-M1r8O-ARnV7",
    machineName: "JAWS (Premium)",
    name: "Drew",
    score: "10",
    ip: "10.4.0.3",
    now: 3000,
  });
  assert.notEqual(other.id, first.id);
  assert.equal(store.getState().leaderboards.length, 0);
  assert.equal(store.getState().scoreSubmissions.filter((row) => row.status === "pending").length, 2);
  const reloaded = await Store.load(filePath);
  const pending = reloaded.getState().scoreSubmissions.filter((row) => row.status === "pending");
  assert.equal(pending.length, 2);
  assert.equal(pending.find((row) => row.id === first.id).machineName, "JAWS (Pro)");
  assert.equal(pending.find((row) => row.id === first.id).boardId, "");
  await reloaded.setSubmissionMachine(first.id, {
    opdbId: "GLWll-M1r8O-A1kx7",
    machineName: "JAWS (LE)",
    manufacturer: "Stern",
    year: "2024",
    edition: "LE edition",
  });
  assert.equal(reloaded.getState().scoreSubmissions.find((row) => row.id === first.id).opdbId, "GLWll-M1r8O-A1kx7");
  const created = await reloaded.createLeaderboard("JAWS (LE)", {
    kind: "machine",
    opdbId: "GLWll-M1r8O-A1kx7",
    manufacturer: "Stern",
    year: "2024",
  });
  const boardId = created.leaderboards.find((board) => board.opdbId === "GLWll-M1r8O-A1kx7").id;
  await reloaded.assignSubmissionBoard(first.id, boardId);
  await reloaded.reviewScore(first.id, "approved");
  const board = reloaded.getState().leaderboards.find((item) => item.id === boardId);
  assert.equal(board.rows[0].name, "Casey");
  assert.equal(board.rows[0].score, 4200);
});
