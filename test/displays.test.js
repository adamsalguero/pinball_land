const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mapDisplaysToSlots } = require("../src/displays");

test("maps attached displays left-to-right, max three, extra ignored", () => {
  const mapped = mapDisplaysToSlots([
    { id: "right", bounds: { x: 3840, y: 0, width: 1920, height: 1080 } },
    { id: "left", bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: "center", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
    { id: "extra", bounds: { x: 5760, y: 0, width: 1920, height: 1080 } },
  ]);
  assert.deepEqual(
    mapped.map((item) => [item.slot, item.id]),
    [
      [1, "left"],
      [2, "center"],
      [3, "right"],
    ]
  );
});

test("one monitor maps only to display 1", () => {
  const mapped = mapDisplaysToSlots([{ id: "only", bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].slot, 1);
});
