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

module.exports = { classifyImage };
