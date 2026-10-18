const { test } = require("node:test");

test("occluded Chrome plays each cached cartoon past 60s on three windows", { skip: process.env.PINBALL_HEADED_CLIPS !== "1" }, async () => {
  const { runHeadedCartoons } = require("../scripts/headed-cartoons");
  await runHeadedCartoons();
});
