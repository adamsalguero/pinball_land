const path = require("path");
const { defaultDataDir } = require("../src/paths");
const { runSelfUpdate } = require("../src/self-update");

const mode = process.argv.includes("--nightly") ? "nightly" : process.argv.includes("--now") ? "now" : "boot";
const recordOnly = process.argv.includes("--status-only");
const appRoot = process.env.PINBALL_APP_ROOT
  ? path.resolve(process.env.PINBALL_APP_ROOT)
  : path.join(__dirname, "..");

function exitCode(result) {
  if (!recordOnly || !result) return 0;
  if (result.action === "update-available") return 10;
  if (result.action === "skipped" && /fetch|resolve|timed out|unable to access|offline/i.test(result.detail || "")) return 11;
  return 0;
}

runSelfUpdate({
  appRoot,
  dataDir: defaultDataDir(),
  mode,
  recordOnly,
})
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(exitCode(result));
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(recordOnly ? 11 : 0);
  });
