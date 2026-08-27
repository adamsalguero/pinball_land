const fs = require("fs");
const path = require("path");

const LOGO_EXTENSIONS = [".svg", ".png", ".jpg", ".jpeg", ".webp"];
const PHOTO_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const LOGO_KEYS = ["pinnacle", "pinball-land"];
const PHOTO_KEYS = ["arcade", "oasis"];

function findMediaFile(dir, key, extensions = LOGO_EXTENSIONS) {
  if (!dir) return null;
  for (const ext of extensions) {
    const filePath = path.join(dir, `${key}${ext}`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

function resolveMedia(dir, keys, urlPrefix, extensions) {
  const out = {};
  for (const key of keys) {
    const filePath = findMediaFile(dir, key, extensions);
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
  return resolveMedia(logosDir, LOGO_KEYS, "/logos", LOGO_EXTENSIONS);
}

function resolvePhotos(photosDir) {
  return resolveMedia(photosDir, PHOTO_KEYS, "/photos", PHOTO_EXTENSIONS);
}

module.exports = {
  EXTENSIONS: LOGO_EXTENSIONS,
  LOGO_EXTENSIONS,
  PHOTO_EXTENSIONS,
  LOGO_KEYS,
  PHOTO_KEYS,
  KEYS: LOGO_KEYS,
  findMediaFile,
  findLogoFile: (dir, key) => findMediaFile(dir, key, LOGO_EXTENSIONS),
  resolveMedia,
  resolveLogos,
  resolvePhotos,
};
