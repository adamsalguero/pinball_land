const path = require("path");
const { defaultDataDir } = require("../src/paths");
const { runSelfUpdate } = require("../src/self-update");

const mode = process.argv.includes("--nightly") ? "nightly" : process.argv.includes("--now") ? "now" : "boot";

runSelfUpdate({
  appRoot: path.join(__dirname, ".."),
  dataDir: defaultDataDir(),
  mode,
})
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(0);
  });
