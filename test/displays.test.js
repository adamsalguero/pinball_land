const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mapDisplaysToSlots,
  physicalBounds,
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

test("a 150 percent monitor stays in DIP bounds and converts to physical pixels", () => {
  const mapped = mapDisplaysToSlots([
    { id: "left", scaleFactor: 1.5, bounds: { x: -1280, y: 0, width: 1280, height: 720 } },
  ], { count: 1 });
  assert.equal(mapped.windows[0].scaleFactor, 1.5);
  assert.deepEqual(mapped.windows[0].bounds, { x: -1280, y: 0, width: 1280, height: 720 });
  assert.deepEqual(physicalBounds(mapped.windows[0].bounds, mapped.windows[0].scaleFactor), {
    x: -1920,
    y: 0,
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(physicalBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 1), {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });
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
      1: { enabled: true, content: "logos" },
      2: { enabled: true, content: "video" },
      3: { enabled: false, content: "leaderboard", leaderboardId: "board-a" },
    },
  });
  assert.equal(config.screens["2"].content, "video");
  const layout = layoutForDisplays(config);
  assert.equal(layout["1"].content, "logos");
  assert.equal(layout["2"].content, "logos");
  assert.equal(layout["2"].staggerIndex, 0);
  assert.equal(layout["3"].enabled, false);
  assert.equal(layout["1"].staggerIndex, 0);
});

test("window layout ignores content changes and follows count, enable, order, and restart", () => {
  const base = { count: 3, screens: { 1: { content: "rotation", enabled: true } } };
  const changedContent = { count: 3, screens: { 1: { content: "video", enabled: true } } };
  assert.equal(windowLayoutKey(base, 1), windowLayoutKey(changedContent, 1));
  assert.notEqual(windowLayoutKey(base, 1), windowLayoutKey({ count: 2 }, 1));
  assert.notEqual(windowLayoutKey(base, 1), windowLayoutKey(base, 2));
  assert.notEqual(
    windowLayoutKey(base, 1),
    windowLayoutKey({ count: 3, screens: { 2: { enabled: false } } }, 1)
  );
});

test("black, dark, and split amenities become rotation or one amenities mode", () => {
  const config = normalizeDisplays({
    screens: {
      1: { content: "black" },
      2: { content: "dark" },
      3: { content: "off" },
    },
  });
  assert.equal(config.screens["1"].content, "rotation");
  assert.equal(config.screens["2"].content, "rotation");
  assert.equal(config.screens["3"].content, "rotation");
  const legacy = normalizeDisplays({
    screens: {
      1: { content: "amenity-arcade" },
      2: { content: "pinnacle" },
      3: { content: "photos" },
    },
  });
  assert.equal(legacy.screens["1"].content, "amenities");
  assert.equal(legacy.screens["2"].content, "logos");
  assert.equal(legacy.screens["3"].content, "pinboard");
});

test("clock is a real per-screen choice", () => {
  const config = normalizeDisplays({ screens: { 2: { content: "clock" } } });
  assert.equal(config.screens["2"].content, "clock");
});

test("slot labels follow the active count", () => {
  assert.equal(slotLabel(1, 1), "Screen");
  assert.equal(slotLabel(2, 2), "Right");
  assert.equal(slotLabel(2, 3), "Center");
});
