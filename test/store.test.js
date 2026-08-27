const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");

let filePath;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-land-"));
  filePath = path.join(dir, "state.json");
});

test("seeds a Halloween board and three slots on first load", async () => {
  const store = await Store.load(filePath);
  const state = store.getState();
  assert.equal(state.leaderboards[0].name, "Halloween party");
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

test("clear board and black-all persist", async () => {
  const store = await Store.load(filePath);
  const boardId = store.getState().leaderboards[0].id;
  await store.clearLeaderboard(boardId);
  await store.blackAll();
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().leaderboards[0].rows.length, 0);
  assert.equal(reloaded.getState().slots["1"].content, "off");
  assert.equal(reloaded.getState().slots["2"].content, "off");
  assert.equal(reloaded.getState().slots["3"].content, "off");
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
  assert.equal(state.slots["1"].content, "photos");
  assert.equal(state.slots["2"].content, "photos");
  assert.equal(state.slots["3"].content, "photos");
  assert.equal(state.leaderboards[0].name, "Keep me");
  await store.setTheme("pinnacle");
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().theme, "pinnacle");
});

test("assigns collage slot and reloads", async () => {
  const store = await Store.load(filePath);
  await store.setSlot("2", { content: "photos" });
  const reloaded = await Store.load(filePath);
  assert.equal(reloaded.getState().slots["2"].content, "photos");
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
