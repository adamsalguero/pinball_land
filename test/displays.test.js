const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mapDisplaysToSlots,
  layoutForDisplays,
  normalizeDisplays,
  windowLayoutKey,
  slotLabel,
} = require("../src/displays");

const monitors = [
  { id: "right", bounds: { x: 3840, y: 0, width: 1920, height: 1080 } },
  { id: "left", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: "center", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
  { id: "extra", bounds: { x: 5760, y: 0, width: 1920, height: 1080 } },
];

test("maps attached displays left-to-right, max three, extra ignored", () => {
  const mapped = mapDisplaysToSlots(monitors);
  assert.deepEqual(
    mapped.windows.map((item) => [item.slot, item.id]),
    [
      [1, "left"],
      [2, "center"],
      [3, "right"],
    ]
  );
  assert.deepEqual(mapped.skipped, []);
});

test("one monitor maps only to display 1 and skips the missing configured screens", () => {
  const mapped = mapDisplaysToSlots([{ id: "only", bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  assert.equal(mapped.windows.length, 1);
  assert.equal(mapped.windows[0].slot, 1);
  assert.deepEqual(mapped.skipped, [2, 3]);
});

test("count and disabled screens open fewer windows without shifting the rest", () => {
  const mapped = mapDisplaysToSlots(monitors, {
    count: 3,
    screens: {
      1: { enabled: true },
      2: { enabled: false },
      3: { enabled: true },
    },
  });
  assert.deepEqual(
    mapped.windows.map((item) => [item.slot, item.id]),
    [
      [1, "left"],
      [3, "right"],
    ]
  );
  assert.deepEqual(mapped.skipped, []);
});

test("manual order override wins over left-to-right, unknown ids are ignored", () => {
  const mapped = mapDisplaysToSlots(monitors, {
    count: 2,
    order: ["missing", "right", "left"],
  });
  assert.deepEqual(
    mapped.windows.map((item) => item.id),
    ["right", "left"]
  );
  assert.deepEqual(mapped.skipped, []);
});

test("fewer monitors than the configured count are skipped", () => {
  const mapped = mapDisplaysToSlots(
    [{ id: "only", bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
    { count: 3 }
  );
  assert.deepEqual(mapped.windows.map((item) => item.slot), [1]);
  assert.deepEqual(mapped.skipped, [2, 3]);
});

test("mirror keeps each screen's saved content but shows screen 1 and the same rotation index", () => {
  const config = normalizeDisplays({
    count: 3,
    mirror: true,
    screens: {
      1: { enabled: true, content: "pinnacle" },
      2: { enabled: true, content: "off" },
      3: { enabled: false, content: "leaderboard", leaderboardId: "board-a" },
    },
  });
  assert.equal(config.screens["2"].content, "off");
  const layout = layoutForDisplays(config);
  assert.equal(layout["1"].content, "pinnacle");
  assert.equal(layout["2"].content, "pinnacle");
  assert.equal(layout["2"].staggerIndex, 0);
  assert.equal(layout["3"].enabled, false);
  assert.equal(layout["1"].staggerIndex, 0);
});

test("window layout ignores content changes and follows count, enable, order, and restart", () => {
  const base = { count: 3, screens: { 1: { content: "rotation", enabled: true } } };
  const changedContent = { count: 3, screens: { 1: { content: "off", enabled: true } } };
  assert.equal(windowLayoutKey(base, 1), windowLayoutKey(changedContent, 1));
  assert.notEqual(windowLayoutKey(base, 1), windowLayoutKey({ count: 2 }, 1));
  assert.notEqual(windowLayoutKey(base, 1), windowLayoutKey(base, 2));
  assert.notEqual(
    windowLayoutKey(base, 1),
    windowLayoutKey({ count: 3, screens: { 2: { enabled: false } } }, 1)
  );
});

test("slot labels follow the active count", () => {
  assert.equal(slotLabel(1, 1), "Screen");
  assert.equal(slotLabel(2, 2), "Right");
  assert.equal(slotLabel(2, 3), "Center");
});
