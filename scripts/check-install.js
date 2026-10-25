const path = require("path");
const { dataLayout, defaultDataDir } = require("../src/paths");
const { readUpdateStatusSync, repairInstall, writeUpdateStatus } = require("../src/self-update");

const scanOnly = process.argv.includes("--scan");
const appRoot = process.env.PINBALL_APP_ROOT
  ? path.resolve(process.env.PINBALL_APP_ROOT)
  : path.join(__dirname, "..");
const dataDir = defaultDataDir();

repairInstall({ appRoot, dataDir, scanOnly })
  .then(async (result) => {
    if (process.env.PINBALL_UPDATE_OFFLINE === "1") {
      const logsDir = dataLayout(dataDir).logs;
      const current = readUpdateStatusSync(logsDir) || {};
      await writeUpdateStatus(logsDir, {
        ...current,
        at: new Date().toISOString(),
        mode: "boot",
        action: "skipped",
        commit: current.commit || "",
        detail: "github.com did not resolve. Starting the current version.",
        integrityAt: result.at,
        integrityOk: result.ok === true,
        integrityDetail: result.detail || "",
      });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 2);
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
