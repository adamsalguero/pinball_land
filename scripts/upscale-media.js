const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const binary = process.argv[2] || process.env.REALESRGAN || "realesrgan-ncnn-vulkan";
const input = process.argv[3];
const output = process.argv[4];
if (!input || !output) {
  console.log("Usage: node scripts/upscale-media.js [realesrgan-binary] input output");
  console.log("Prefers realesrgan-ncnn-vulkan -n realesrgan-x4plus -s 4. Falls back to a sharp Lanczos resize and says so.");
  process.exit(process.argv.length > 2 ? 1 : 0);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const run = spawnSync(binary, ["-i", input, "-o", output, "-n", "realesrgan-x4plus", "-s", "4"], { stdio: "inherit" });
if (run.status === 0 && fs.existsSync(output)) {
  console.log(`Real-ESRGAN wrote ${output}`);
  process.exit(0);
}
console.warn("Real-ESRGAN did not run. Writing a Lanczos enlarge instead.");
sharp(input)
  .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: false, kernel: "lanczos3" })
  .toFile(output)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
