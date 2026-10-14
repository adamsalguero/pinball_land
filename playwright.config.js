const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "e2e",
  timeout: 30000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  use: {
    baseURL: "http://127.0.0.1:3210",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "node src/server.js",
    url: "http://127.0.0.1:3210/api/health",
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: "3210",
      HTTPS_PORT: "0",
      PINBALL_DATA_DIR: "e2e-data",
      PINBALL_PLUG_MOCK: "1",
      NODE_TEST_CONTEXT: "1",
    },
  },
});
