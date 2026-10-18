const { test } = require("node:test");

test("one Chrome profile keeps three overlapped displays playing with bounded media sockets", {
  skip: process.env.PINBALL_POOL_SOAK !== "1",
  timeout: 20 * 60 * 1000,
}, async () => {
  const { runPoolSoak } = require("../scripts/pool-soak");
  await runPoolSoak();
});
