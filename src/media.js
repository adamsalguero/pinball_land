const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const FOLDERS = ["library", "halloween", "christmas"];
const VIDEO_EXTS = [".mp4", ".m4v", ".webm", ".mov", ".mkv"];
const MAX_BYTES = 8 * 1024 * 1024 * 1024;

const MIME_EXT = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "application/octet-stream": "",
};

function normalizeFolder(value) {
  const folder = String(value || "library").trim().toLowerCase();
  return FOLDERS.includes(folder) ? folder : null;
}

function normalizeTags(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const tags = [];
  for (const item of source) {
    const tag = String(item || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 24);
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= 12) break;
  }
  return tags;
}

function extensionFor(filename, mime) {
  const fromName = path.extname(String(filename || "")).toLowerCase();
  if (VIDEO_EXTS.includes(fromName)) return fromName;
  const fromMime = MIME_EXT[String(mime || "").split(";")[0].trim().toLowerCase()];
  if (fromMime && VIDEO_EXTS.includes(fromMime)) return fromMime;
  return null;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "");
  const folder = normalizeFolder(raw.folder);
  const file = path.basename(String(raw.file || ""));
  if (!/^[0-9a-f-]{36}$/i.test(id) || !folder || !file || file !== raw.file) return null;
  if (!VIDEO_EXTS.includes(path.extname(file).toLowerCase())) return null;
  return {
    id,
    title: String(raw.title || "Video").trim().slice(0, 80) || "Video",
    file,
    folder,
    tags: normalizeTags(raw.tags),
    allAges: raw.allAges !== false,
    inRotation: Boolean(raw.inRotation),
    loop: raw.loop !== false,
    bytes: Number(raw.bytes) || 0,
    addedAt: Number(raw.addedAt) || Date.now(),
  };
}

function includeInRotation(video, { theme, allAges = true } = {}) {
  if (!video) return false;
  if (allAges && video.allAges === false) return false;
  const tags = video.tags || [];
  if (theme === "halloween" && (video.folder === "halloween" || tags.includes("halloween"))) return true;
  if (theme === "christmas" && (video.folder === "christmas" || tags.includes("christmas"))) return true;
  return Boolean(video.inRotation);
}

class MediaLibrary {
  constructor({ root, catalogPath } = {}) {
    if (!root) throw new Error("MediaLibrary needs a root folder");
    this.root = root;
    this.catalogPath = catalogPath || path.join(root, "library.json");
    this.items = [];
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.catalogPath, "utf8"));
      const items = Array.isArray(parsed.items) ? parsed.items : parsed;
      this.items = (Array.isArray(items) ? items : []).map(normalizeItem).filter(Boolean);
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`Could not read media catalog: ${err.message}`);
      this.items = [];
    }
  }

  async save() {
    await fsp.mkdir(path.dirname(this.catalogPath), { recursive: true });
    const tmp = `${this.catalogPath}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify({ items: this.items }, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, this.catalogPath);
  }

  toPublic(item) {
    return {
      id: item.id,
      title: item.title,
      folder: item.folder,
      tags: item.tags,
      allAges: item.allAges,
      inRotation: item.inRotation,
      loop: item.loop,
      bytes: item.bytes,
      addedAt: item.addedAt,
      url: `/media/videos/${item.id}`,
    };
  }

  list() {
    return this.items.map((item) => this.toPublic(item));
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  filePath(item) {
    return path.join(this.root, item.folder, item.file);
  }

  async add(fields) {
    const folder = normalizeFolder(fields.folder);
    const ext = extensionFor(fields.filename, fields.mime);
    if (!folder) throw Object.assign(new Error("Folder must be library, halloween, or christmas"), { status: 400 });
    if (!ext) throw Object.assign(new Error("Upload an mp4, m4v, webm, mov, or mkv video"), { status: 400 });
    const id = crypto.randomUUID();
    const file = `${id}${ext}`;
    const item = normalizeItem({
      id,
      title: fields.title || path.basename(String(fields.filename || "Video"), ext),
      file,
      folder,
      tags: fields.tags,
      allAges: fields.allAges !== false && fields.allAges !== "false",
      inRotation: fields.inRotation === true || fields.inRotation === "true",
      loop: fields.loop !== false && fields.loop !== "false",
      bytes: fields.bytes || 0,
      addedAt: Date.now(),
    });
    await fsp.mkdir(path.join(this.root, folder), { recursive: true });
    this.items.push(item);
    await this.save();
    return item;
  }

  async update(id, patch) {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error("Unknown video"), { status: 404 });
    if (patch.title !== undefined) item.title = String(patch.title || "").trim().slice(0, 80) || item.title;
    if (patch.tags !== undefined) item.tags = normalizeTags(patch.tags);
    if (patch.allAges !== undefined) item.allAges = Boolean(patch.allAges);
    if (patch.inRotation !== undefined) item.inRotation = Boolean(patch.inRotation);
    if (patch.loop !== undefined) item.loop = Boolean(patch.loop);
    if (patch.folder !== undefined) {
      const folder = normalizeFolder(patch.folder);
      if (!folder) throw Object.assign(new Error("Folder must be library, halloween, or christmas"), { status: 400 });
      if (folder !== item.folder) {
        const nextPath = path.join(this.root, folder, item.file);
        await fsp.mkdir(path.dirname(nextPath), { recursive: true });
        await fsp.rename(this.filePath(item), nextPath).catch((err) => {
          if (err.code !== "ENOENT") throw err;
        });
        item.folder = folder;
      }
    }
    await this.save();
    return this.toPublic(item);
  }

  async remove(id) {
    const item = this.get(id);
    if (!item) return null;
    this.items = this.items.filter((entry) => entry.id !== id);
    await fsp.unlink(this.filePath(item)).catch(() => {});
    await this.save();
    return item;
  }
}

module.exports = {
  FOLDERS,
  VIDEO_EXTS,
  MAX_BYTES,
  normalizeFolder,
  normalizeTags,
  extensionFor,
  includeInRotation,
  MediaLibrary,
};
