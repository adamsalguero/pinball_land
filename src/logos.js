const fs = require("fs");
const path = require("path");

const KEYS = ["pinnacle", "pinball-land"];
const EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];

function findLogoFile(logosDir, key) {
  for (const ext of EXTENSIONS) {
    const filePath = path.join(logosDir, `${key}${ext}`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function resolveLogos(logosDir) {
  const logos = {};
  for (const key of KEYS) {
    const filePath = findLogoFile(logosDir, key);
    if (filePath) {
      const stat = fs.statSync(filePath);
      logos[key] = {
        url: `/logos/${key}?v=${stat.mtimeMs}`,
        filePath,
        filename: path.basename(filePath),
      };
    } else {
      logos[key] = { url: null, filePath: null, filename: null };
    }
  }
  return logos;
}

module.exports = { KEYS, findLogoFile, resolveLogos };
