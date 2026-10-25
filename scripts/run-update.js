const path = require("path");
const { defaultDataDir } = require("../src/paths");
const { runSelfUpdate } = require("../src/self-update");

const mode = process.argv.includes("--nightly") ? "nightly" : process.argv.includes("--now") ? "now" : "boot";
const recordOnly = process.argv.includes("--status-only");
const stageOnly = process.argv.includes("--stage-only");
const swapOnly = process.argv.includes("--swap-staged");
const appRoot = process.env.PINBALL_APP_ROOT
  ? path.resolve(process.env.PINBALL_APP_ROOT)
  : path.join(__dirname, "..");

function exitCode(result) {
  if (recordOnly && result) {
    if (result.action === "update-available") return 10;
    if (result.action === "skipped" && /fetch|resolve|timed out|unable to access|offline/i.test(result.detail || "")) return 11;
    return 0;
  }
  if (stageOnly && (!result || result.action !== "staged")) return 2;
  if (swapOnly && (!result || result.action !== "updated")) return 2;
  return 0;
}

runSelfUpdate({
  appRoot,
  dataDir: defaultDataDir(),
  mode,
  recordOnly,
  stageOnly,
  swapOnly,
})
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(exitCode(result));
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(recordOnly ? 11 : 0);
  });
