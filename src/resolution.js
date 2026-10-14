const fs = require("fs");

function readImageSize(filePath) {
  let buf;
  try {
    const fd = fs.openSync(filePath, "r");
    buf = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    buf = buf.subarray(0, bytes);
  } catch {
    return null;
  }
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      const size = buf.readUInt16BE(offset + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      if (!size) break;
      offset += 2 + size;
    }
  }
  return null;
}

function classifyImage({ width, height, slotWidth = 1920, slotHeight = 1080, guest = false } = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (guest) {
    if (w >= 320 && h >= 240) {
      return { ok: true, mode: "collage", warning: null };
    }
    return { ok: false, mode: "rejected", warning: "That photo is too small. Use the camera or a larger picture." };
  }
  const minW = Math.round(slotWidth * 0.7);
  const minH = Math.round(slotHeight * 0.7);
  if (w >= minW && h >= minH) return { ok: true, mode: "full", warning: null };
  if (w >= 640 && h >= 360) {
    return {
      ok: true,
      mode: "collage",
      warning: `This image is ${w}×${h}. It stays collage-size on a ${slotWidth}×${slotHeight} screen.`,
    };
  }
  return {
    ok: false,
    mode: "rejected",
    warning: `This image is ${w}×${h}, below the wall minimum. Upscale it or choose a larger file.`,
  };
}

module.exports = { readImageSize, classifyImage };
