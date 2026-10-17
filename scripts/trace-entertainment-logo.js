#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "public", "logos", "pinball-land.png");
const SCALE = 4;

function classify(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum > 236 && chroma < 28) return "white";
  if (g > r + 6 && g >= b - 4 && g > 45 && lum < 190 && chroma > 8) return "green";
  if (r > g + 10 && b > g + 6 && r > 45 && chroma > 12) {
    return lum > 125 || r > 145 ? "lavender" : "purple";
  }
  if (lum < 175 && chroma < 42) return "charcoal";
  return "bg";
}

function writePbm(file, mask, w, h) {
  const rowBytes = Math.ceil(w / 8);
  const buf = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      buf[y * rowBytes + (x >> 3)] |= 1 << (7 - (x & 7));
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P4\n${w} ${h}\n`), buf]));
}

function trace(mask, w, h) {
  const dir = fs.mkdtempSync(path.join("/tmp", "pl-logo-"));
  const pbm = path.join(dir, "layer.pbm");
  const svg = path.join(dir, "layer.svg");
  writePbm(pbm, mask, w, h);
  const result = spawnSync("potrace", [pbm, "-s", "-o", svg, "--flat", "-t", "8", "-a", "1.05", "-O", "0.25"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "potrace failed");
  const text = fs.readFileSync(svg, "utf8");
  const d = [...text.matchAll(/d="([^"]+)"/g)].map((match) => match[1]);
  const transform = (text.match(/transform="([^"]+)"/) || [])[1] || "";
  return { d, transform };
}

function group(id, fill, traced) {
  const body = traced.d.map((d) => `<path d="${d}"/>`).join("");
  return `<g id="${id}" fill="${fill}" fill-rule="evenodd" transform="${traced.transform}">${body}</g>`;
}

(async () => {
  const { data, info } = await sharp(SRC)
    .resize(500 * SCALE, 500 * SCALE, { kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const layers = {
    green: new Uint8Array(w * h),
    purple: new Uint8Array(w * h),
    lavender: new Uint8Array(w * h),
    white: new Uint8Array(w * h),
    charcoal: new Uint8Array(w * h),
  };
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const kind = classify(data[i], data[i + 1], data[i + 2]);
    if (layers[kind]) layers[kind][p] = 1;
  }
  const fills = {
    green: "#2d4c32",
    charcoal: "#504E50",
    purple: "#62006E",
    lavender: "#a269a9",
    white: "#ffffff",
  };
  const parts = ["green", "charcoal", "purple", "lavender", "white"].map((key) => group(key, fills[key], trace(layers[key], w, h)));
  const logo = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 ${w} ${h}" role="img" aria-label="Pinnacle Entertainment Center California">
  <title>Pinnacle Entertainment Center</title>
  ${parts.join("\n  ")}
</svg>
`;
  const logoPath = path.join(ROOT, "public", "logos", "pinball-land.svg");
  fs.writeFileSync(logoPath, logo);
  console.log("wrote", logoPath, logo.length);

  const top = Math.floor(h * 0.36);
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < top; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!layers.purple[y * w + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const pad = 12;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(top - 1, maxY + pad);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const crop = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      crop[y * cw + x] = layers.purple[(y + minY) * w + (x + minX)];
    }
  }
  const flip = trace(crop, cw, ch);
  const fit = 300;
  const scale = fit / cw;
  const left = (512 - cw * scale) / 2;
  const topPad = (512 - ch * scale) / 2;
  const flipBody = flip.d.map((d) => `<path d="${d}"/>`).join("");
  const mark = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="Pinnacle Entertainment Center">
  <rect width="512" height="512" rx="96" fill="#62006E"/>
  <g fill="#f8f8f5" fill-rule="evenodd" transform="translate(${left.toFixed(2)} ${topPad.toFixed(2)}) scale(${scale.toFixed(5)}) ${flip.transform}">
    ${flipBody}
  </g>
</svg>
`;
  const markPath = path.join(ROOT, "public", "icons", "mark.svg");
  fs.writeFileSync(markPath, mark);
  const iconDir = path.join(ROOT, "public", "icons");
  const sizes = [
    ["guest-180.png", 180],
    ["admin-180.png", 180],
    ["guest-192.png", 192],
    ["admin-192.png", 192],
    ["guest-512.png", 512],
    ["admin-512.png", 512],
  ];
  for (const [name, size] of sizes) {
    await sharp(Buffer.from(mark)).resize(size, size).png().toFile(path.join(iconDir, name));
  }
  const maskFit = 220;
  const maskScale = maskFit / cw;
  const maskLeft = (512 - cw * maskScale) / 2;
  const maskTop = (512 - ch * maskScale) / 2;
  const maskSvg = mark
    .replace('rx="96"', 'rx="0"')
    .replace(
      /transform="[^"]+"/,
      `transform="translate(${maskLeft.toFixed(2)} ${maskTop.toFixed(2)}) scale(${maskScale.toFixed(5)}) ${flip.transform}"`,
    );
  for (const name of ["guest-maskable-512.png", "admin-maskable-512.png"]) {
    await sharp(Buffer.from(maskSvg)).resize(512, 512).png().toFile(path.join(iconDir, name));
  }
  const splashMark = await sharp(Buffer.from(maskSvg.replace('rx="0"', 'rx="0"'))).resize(460, 460).png().toBuffer();
  for (const name of ["guest-splash.png", "admin-splash.png"]) {
    await sharp({
      create: { width: 1170, height: 2532, channels: 4, background: "#62006E" },
    }).composite([{ input: splashMark, gravity: "center" }]).png().toFile(path.join(iconDir, name));
  }
  console.log("wrote icons");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
