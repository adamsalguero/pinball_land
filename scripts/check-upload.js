const path = require("path");
const { defaultDataDir } = require("../src/paths");
const { writeIntegrityStatus } = require("../src/install-guard");
const { checkUploadPath, repairUploadPath } = require("../src/upload-check");

const repair = process.argv.includes("--repair");
const appRoot = process.env.PINBALL_APP_ROOT
  ? path.resolve(process.env.PINBALL_APP_ROOT)
  : path.join(__dirname, "..");
const dataDir = defaultDataDir();

(repair
  ? repairUploadPath({ appRoot, dataDir })
  : checkUploadPath(appRoot).then(async (result) => {
    await writeIntegrityStatus(dataDir, {
      at: new Date().toISOString(),
      ok: result.ok === true,
      detail: result.detail || "",
    });
    return result;
  }))
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 2);
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  });
