const { test } = require("node:test");
const assert = require("node:assert/strict");

require("../public/build-watch.js");

test("a page reloads once when a later build id differs", () => {
  const reloads = [];
  globalThis.location = {
    reload() {
      reloads.push(globalThis.PinballBuild);
    },
  };
  delete globalThis.__pinballReloading;
  assert.equal(globalThis.PinballBuild.watchBuild(""), false);
  assert.equal(globalThis.PinballBuild.watchBuild("abc123"), false);
  assert.equal(globalThis.PinballBuild.watchBuild("abc123"), false);
  assert.equal(globalThis.PinballBuild.watchBuild("def456"), true);
  assert.equal(reloads.length, 1);
  assert.equal(globalThis.PinballBuild.watchBuild("ghi789"), false);
  assert.equal(reloads.length, 1);
});
