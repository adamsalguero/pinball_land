const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { checkUploadPath, repairUploadPath } = require("../src/upload-check");
const { stagePaths } = require("../src/install-guard");

const root = path.join(__dirname, "..");

async function copyProcessor(dir) {
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "node_modules", "sharp"), { recursive: true });
  for (const name of ["photos.js", "resolution.js", "text-filter.js"]) {
    await fs.copyFile(path.join(root, "src", name), path.join(dir, "src", name));
  }
  await fs.writeFile(path.join(dir, "package.json"), `${JSON.stringify({ name: "upload-fixture", private: true })}\n`);
}

function sharpStub(broken) {
  if (broken) return "module.exports = function sharp() { throw new Error('bad native binding'); };\n";
  return [
    "function sharp() {",
    "  const api = {",
    "    rotate() { return api; },",
    "    resize() { return api; },",
    "    jpeg() { return api; },",
    "    metadata: async () => ({ width: 320, height: 240 }),",
    "    toBuffer: async () => ({ data: Buffer.from([255, 216, 255, 217]), info: { width: 320, height: 240 } }),",
    "  };",
    "  return api;",
    "}",
    "module.exports = sharp;",
    "",
  ].join("\n");
}

test("the real upload path processes a fixture image outside the gallery", async () => {
  const result = await checkUploadPath(root);
  assert.equal(result.ok, true);
  assert.match(result.detail, /upload path ok \(\d+ bytes\)/);
});

test("a broken sharp install fails the upload check with the error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-upload-bad-"));
  await copyProcessor(dir);
  await fs.writeFile(path.join(dir, "node_modules", "sharp", "index.js"), sharpStub(true));
  const result = await checkUploadPath(dir);
  assert.equal(result.ok, false);
  assert.match(result.detail, /upload path failed/);
  assert.match(result.detail, /bad native binding|photo processor unavailable|not a photo/);
});

test("upload repair copies sharp from the backup tree and rechecks", async () => {
  const live = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-upload-live-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-upload-data-"));
  const paths = stagePaths(live);
  await copyProcessor(live);
  await copyProcessor(paths.previous);
  await fs.writeFile(path.join(live, "node_modules", "sharp", "index.js"), sharpStub(true));
  await fs.writeFile(path.join(paths.previous, "node_modules", "sharp", "index.js"), sharpStub(false));
  const result = await repairUploadPath({ appRoot: live, dataDir });
  assert.equal(result.ok, true);
  assert.equal(result.action, "repaired");
  assert.match(result.detail, /reinstalled sharp/);
  assert.match(result.detail, /upload path ok/);
  const status = JSON.parse(await fs.readFile(path.join(dataDir, "logs", "update-status.json"), "utf8"));
  assert.equal(status.integrityOk, true);
  assert.match(status.integrityDetail, /bad native binding|reinstalled sharp|upload path ok/);
});

test("upload repair rolls back when the package copy cannot fix the tree", async () => {
  const live = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-upload-roll-"));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pinball-upload-roll-data-"));
  const paths = stagePaths(live);
  await copyProcessor(live);
  await copyProcessor(paths.previous);
  await fs.writeFile(path.join(live, "node_modules", "sharp", "index.js"), sharpStub(true));
  await fs.writeFile(path.join(paths.previous, "node_modules", "sharp", "index.js"), sharpStub(false));
  await fs.writeFile(path.join(paths.previous, "restored.txt"), "previous");
  const result = await repairUploadPath({
    appRoot: live,
    dataDir,
    copyPackage: async () => {
      throw new Error("copy blocked");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, "rolled-back");
  assert.match(result.detail, /restored the previous install/);
  assert.equal(await fs.readFile(path.join(live, "restored.txt"), "utf8"), "previous");
});
