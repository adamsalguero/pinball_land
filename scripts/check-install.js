const path = require("path");
const { dataLayout, defaultDataDir } = require("../src/paths");
const { scanInstall } = require("../src/install-guard");
const { readUpdateStatusSync, repairInstall, writeUpdateStatus } = require("../src/self-update");

const quick = process.argv.includes("--quick");
const zeros = process.argv.includes("--zeros");
const offlineNote = process.argv.includes("--offline-note");
const scanOnly = process.argv.includes("--scan") || quick;
const appRoot = process.env.PINBALL_APP_ROOT
  ? path.resolve(process.env.PINBALL_APP_ROOT)
  : path.join(__dirname, "..");
const dataDir = defaultDataDir();

async function noteOffline(result) {
  if (process.env.PINBALL_UPDATE_OFFLINE !== "1") return;
  const logsDir = dataLayout(dataDir).logs;
  const current = readUpdateStatusSync(logsDir) || {};
  await writeUpdateStatus(logsDir, {
    ...current,
    at: new Date().toISOString(),
    mode: "boot",
    action: "skipped",
    commit: current.commit || "",
    detail: "github.com did not resolve. Starting the current version.",
    integrityAt: current.integrityAt || result.at || new Date().toISOString(),
    integrityOk: current.integrityAt ? current.integrityOk === true : result.ok === true,
    integrityDetail: current.integrityDetail || result.detail || "",
  });
}

function report(result) {
  return noteOffline(result).then(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 2);
  });
}

if (offlineNote) {
  const logsDir = dataLayout(dataDir).logs;
  const current = readUpdateStatusSync(logsDir) || {};
  writeUpdateStatus(logsDir, {
    ...current,
    at: new Date().toISOString(),
    mode: "boot",
    action: "skipped",
    commit: current.commit || "",
    detail: "github.com did not resolve. Starting the current version.",
    integrityAt: current.integrityAt || null,
    integrityOk: current.integrityAt ? current.integrityOk === true : null,
    integrityDetail: current.integrityDetail || "",
  })
    .then(() => {
      process.stdout.write(`${JSON.stringify({ ok: true, action: "skipped" })}\n`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(2);
    });
} else if (zeros) {
  const started = Date.now();
  scanInstall(appRoot)
    .then((result) => {
      process.stdout.write(`${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}\n`);
      process.exit(result.ok ? 0 : 2);
    })
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(2);
    });
} else {
  repairInstall({ appRoot, dataDir, scanOnly, quick })
    .then(report)
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(2);
    });
}
