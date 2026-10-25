const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { classifyImage } = require("./resolution");
const { maskProfanity } = require("./text-filter");

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_DAY = 30;
const MAX_STORED = 400;

function cleanText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function loadSharp() {
  try {
    return require("sharp");
  } catch (err) {
    throw Object.assign(new Error("photo processor unavailable"), { status: 503, cause: err });
  }
}

class GuestAlbum {
  constructor({ root, sharpImpl, sharpLoader = loadSharp } = {}) {
    if (!root) throw new Error("GuestAlbum needs a root folder");
    this.root = root;
    this.filesDir = path.join(root, "files");
    this.archiveDir = path.join(root, "archive");
    this.catalogPath = path.join(root, "album.json");
    this.sharp = sharpImpl;
    this.sharpLoader = sharpLoader;
    this.events = [];
    this.photos = [];
    this.hits = new Map();
    this.dayHits = new Map();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.catalogPath, "utf8"));
      this.events = Array.isArray(parsed.events) ? parsed.events : [];
      this.photos = Array.isArray(parsed.photos) ? parsed.photos : [];
    } catch (err) {
      if (err.code !== "ENOENT") console.error(err.message);
      this.events = [];
      this.photos = [];
    }
  }

  async save() {
    await fsp.mkdir(this.root, { recursive: true });
    const tmp = `${this.catalogPath}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify({ events: this.events, photos: this.photos }, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, this.catalogPath);
  }

  allow(ip, now = Date.now()) {
    const key = String(ip || "unknown");
    const recent = (this.hits.get(key) || []).filter((stamp) => now - stamp < WINDOW_MS);
    const day = (this.dayHits.get(key) || []).filter((stamp) => now - stamp < DAY_MS);
    if (recent.length >= MAX_PER_WINDOW || day.length >= MAX_PER_DAY) {
      this.hits.set(key, recent);
      this.dayHits.set(key, day);
      return false;
    }
    recent.push(now);
    day.push(now);
    this.hits.set(key, recent);
    this.dayHits.set(key, day);
    return true;
  }

  ensureEvent(name) {
    const title = cleanText(name, 60) || "Tonight";
    let event = this.events.find((item) => item.name === title);
    if (!event) {
      event = { id: crypto.randomUUID(), name: title, createdAt: Date.now() };
      this.events.push(event);
    }
    return event;
  }

  currentEvent(name) {
    if (this.events.length && !name) return this.events[this.events.length - 1];
    return this.ensureEvent(name);
  }

  async sharpLib() {
    if (this.sharp) return this.sharp;
    try {
      this.sharp = this.sharpLoader();
    } catch (err) {
      if (err && err.status) throw err;
      throw Object.assign(new Error("photo processor unavailable"), { status: 503, cause: err });
    }
    return this.sharp;
  }

  async ingest(buffer, { caption, guestName, eventName, autoApprove = false, paused = false, ip, now } = {}) {
    if (paused) {
      throw Object.assign(new Error("Photo uploads are paused."), { status: 403 });
    }
    if (!this.allow(ip, now)) {
      throw Object.assign(new Error("Too many photos from this phone. Wait a few minutes."), { status: 429 });
    }
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
    if (this.photos.length >= MAX_STORED) {
      throw Object.assign(new Error("The wall is full. Ask the host to clear an event."), { status: 429 });
    }
    if (!body.length) throw Object.assign(new Error("That photo is empty."), { status: 400 });
    if (body.length > 25 * 1024 * 1024) {
      throw Object.assign(new Error("That photo is over 25 MB."), { status: 400 });
    }
    const sharp = await this.sharpLib();
    let image;
    try {
      image = sharp(body, { failOn: "none", animated: false });
      const meta = await image.metadata();
      const verdict = classifyImage({ width: meta.width, height: meta.height, guest: true });
      if (!verdict.ok) throw Object.assign(new Error(verdict.warning), { status: 400 });
      const processed = await image
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 84, progressive: true })
        .toBuffer({ resolveWithObject: true });
      const event = this.currentEvent(eventName);
      const id = crypto.randomUUID();
      await fsp.mkdir(this.filesDir, { recursive: true });
      await fsp.writeFile(path.join(this.filesDir, `${id}.jpg`), processed.data);
      const photo = {
        id,
        eventId: event.id,
        file: `${id}.jpg`,
        width: processed.info.width,
        height: processed.info.height,
        caption: maskProfanity(cleanText(caption, 80)),
        guestName: maskProfanity(cleanText(guestName, 40)),
        status: autoApprove ? "approved" : "pending",
        createdAt: now || Date.now(),
      };
      this.photos.push(photo);
      await this.save();
      return this.toPublic(photo);
    } catch (err) {
      if (err.status) throw err;
      if (err instanceof SyntaxError || /unexpected token/i.test(String(err && err.message))) {
        throw Object.assign(new Error("photo processor unavailable"), { status: 503, cause: err });
      }
      throw Object.assign(new Error("That file is not a photo the wall can use."), { status: 400 });
    }
  }

  toPublic(photo, { includePending = false } = {}) {
    if (!photo) return null;
    if (!includePending && photo.status !== "approved" && photo.status !== "pending" && photo.status !== "rejected") return null;
    return {
      id: photo.id,
      eventId: photo.eventId,
      url: `/media/guest/${photo.id}.jpg`,
      width: photo.width,
      height: photo.height,
      caption: photo.caption,
      guestName: photo.guestName,
      status: photo.status,
      createdAt: photo.createdAt,
    };
  }

  list({ status, eventId } = {}) {
    return this.photos
      .filter((photo) => (status ? photo.status === status : true))
      .filter((photo) => (eventId ? photo.eventId === eventId : true))
      .map((photo) => this.toPublic(photo, { includePending: true }));
  }

  feed() {
    return this.photos
      .filter((photo) => photo.status === "approved")
      .map((photo) => this.toPublic(photo));
  }

  async sendZip(res, photos, filename, nameFor) {
    const { ZipArchive } = require("archiver");
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const finished = new Promise((resolve, reject) => {
      archive.on("error", reject);
      archive.on("end", resolve);
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    archive.pipe(res);
    for (const photo of photos) {
      const filePath = this.filePath(photo);
      if (!filePath || !fs.existsSync(filePath)) continue;
      archive.file(filePath, { name: nameFor(photo) });
    }
    await Promise.all([archive.finalize(), finished]);
  }

  async zipApproved(res) {
    const photos = this.photos.filter((photo) => photo.status === "approved");
    await this.sendZip(res, photos, "pinboard.zip", (photo) => `${photo.id}.jpg`);
  }

  filePath(photo) {
    const folder = photo?.status === "archived" ? this.archiveDir : this.filesDir;
    const target = path.resolve(folder, photo.file);
    const root = path.resolve(folder);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
    return target;
  }

  async deletePhoto(id) {
    const index = this.photos.findIndex((item) => item.id === id);
    if (index === -1) throw Object.assign(new Error("Unknown photo"), { status: 404 });
    const photo = this.photos[index];
    const targets = [path.resolve(this.filesDir, photo.file), path.resolve(this.archiveDir, photo.file)];
    this.photos.splice(index, 1);
    await this.save();
    await Promise.all(targets.map((target) => fsp.unlink(target).catch(() => {})));
    return { deleted: id };
  }

  async archivePhoto(id) {
    const photo = this.photos.find((item) => item.id === id);
    if (!photo) throw Object.assign(new Error("Unknown photo"), { status: 404 });
    if (photo.status === "archived") return this.toPublic(photo, { includePending: true });
    const from = path.resolve(this.filesDir, photo.file);
    await fsp.mkdir(this.archiveDir, { recursive: true });
    const dest = path.resolve(this.archiveDir, photo.file);
    if (fs.existsSync(from)) await fsp.rename(from, dest);
    photo.status = "archived";
    photo.archivedAt = Date.now();
    await this.save();
    return this.toPublic(photo, { includePending: true });
  }

  async restorePhoto(id) {
    const photo = this.photos.find((item) => item.id === id);
    if (!photo) throw Object.assign(new Error("Unknown photo"), { status: 404 });
    if (photo.status !== "archived") return this.toPublic(photo, { includePending: true });
    const from = path.resolve(this.archiveDir, photo.file);
    await fsp.mkdir(this.filesDir, { recursive: true });
    const dest = path.resolve(this.filesDir, photo.file);
    if (fs.existsSync(from)) await fsp.rename(from, dest);
    photo.status = "approved";
    photo.archivedAt = null;
    await this.save();
    return this.toPublic(photo, { includePending: true });
  }

  async setStatus(id, status) {
    const photo = this.photos.find((item) => item.id === id);
    if (!photo) throw Object.assign(new Error("Unknown photo"), { status: 404 });
    if (status !== "approved" && status !== "rejected") {
      throw Object.assign(new Error("Status must be approved or rejected"), { status: 400 });
    }
    photo.status = status;
    await this.save();
    return this.toPublic(photo, { includePending: true });
  }

  async clearEvent(eventId) {
    const event = this.events.find((item) => item.id === eventId);
    if (!event) throw Object.assign(new Error("Unknown event"), { status: 404 });
    const doomed = this.photos.filter((photo) => photo.eventId === eventId);
    this.photos = this.photos.filter((photo) => photo.eventId !== eventId);
    this.events = this.events.filter((item) => item.id !== eventId);
    await this.save();
    await Promise.all(doomed.map((photo) => {
      const target = this.filePath(photo);
      return target ? fsp.unlink(target).catch(() => {}) : Promise.resolve();
    }));
    return { cleared: doomed.length };
  }

  async zipEvent(eventId, res) {
    const event = this.events.find((item) => item.id === eventId) || { name: "photos" };
    const photos = this.photos.filter((photo) => photo.eventId === eventId && photo.status === "approved");
    const filename = `${String(event.name || "photos").replace(/[^\w.-]+/g, "-")}.zip`;
    await this.sendZip(res, photos, filename, (photo) => {
      const safeName = String(photo.guestName || "guest").replace(/[^\w.-]+/g, "-").slice(0, 40) || "guest";
      return `${safeName}-${photo.id}.jpg`;
    });
  }
}

module.exports = { GuestAlbum, loadSharp, WINDOW_MS, MAX_PER_WINDOW, MAX_STORED };
