const fs = require("fs");
const path = require("path");

const EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const LOGO_KEYS = ["pinnacle", "pinball-land"];
const PHOTO_KEYS = ["arcade", "bar", "pool"];

function findMediaFile(dir, key) {
  if (!dir) return null;
  for (const ext of EXTENSIONS) {
    const filePath = path.join(dir, `${key}${ext}`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function resolveMedia(dir, keys, urlPrefix) {
  const out = {};
  for (const key of keys) {
    const filePath = findMediaFile(dir, key);
    if (filePath) {
      const stat = fs.statSync(filePath);
      out[key] = {
        url: `${urlPrefix}/${key}?v=${stat.mtimeMs}`,
        filePath,
        filename: path.basename(filePath),
      };
    } else {
      out[key] = { url: null, filePath: null, filename: null };
    }
  }
  return out;
}

function resolveLogos(logosDir) {
  return resolveMedia(logosDir, LOGO_KEYS, "/logos");
}

function resolvePhotos(photosDir) {
  return resolveMedia(photosDir, PHOTO_KEYS, "/photos");
}

module.exports = {
  EXTENSIONS,
  LOGO_KEYS,
  PHOTO_KEYS,
  KEYS: LOGO_KEYS,
  findMediaFile,
  findLogoFile: (dir, key) => findMediaFile(dir, key),
  resolveMedia,
  resolveLogos,
  resolvePhotos,
};
