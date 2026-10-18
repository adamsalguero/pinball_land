const NUM = "[-+]?(?:\\d*\\.\\d+|\\d+)(?:[eE][-+]?\\d+)?";
const TOKEN = new RegExp(`[MmLlHhVvCcSsQqTtAaZz]|${NUM}`, "g");

function tokensOf(d) {
  return String(d || "").match(TOKEN) || [];
}

function isNum(token) {
  return token != null && /^[-+]?(?:\d*\.\d+|\d+)/.test(token);
}

function pathBoxes(d) {
  const tokens = tokensOf(d);
  const subs = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let box = null;
  const add = (x, y) => {
    box.minX = Math.min(box.minX, x);
    box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y);
    box.maxY = Math.max(box.maxY, y);
  };
  const begin = (x, y) => {
    if (box) subs.push(box);
    box = { minX: x, maxX: x, minY: y, maxY: y, d: "" };
    cx = x;
    cy = y;
    sx = x;
    sy = y;
  };
  while (i < tokens.length) {
    const command = tokens[i];
    if (command === "M" || command === "m") {
      const rel = command === "m" && box;
      let x = Number(tokens[i + 1]);
      let y = Number(tokens[i + 2]);
      i += 3;
      if (rel) {
        x += cx;
        y += cy;
      }
      begin(x, y);
      box.d = `M${x} ${y}`;
      cx = x;
      cy = y;
      while (i + 1 < tokens.length && isNum(tokens[i])) {
        x = Number(tokens[i]);
        y = Number(tokens[i + 1]);
        i += 2;
        if (rel) {
          x += cx;
          y += cy;
        }
        add(x, y);
        box.d += ` L${x} ${y}`;
        cx = x;
        cy = y;
      }
      continue;
    }
    if (!box) {
      i += 1;
      continue;
    }
    if (command === "C" || command === "c") {
      const rel = command === "c";
      const nums = [];
      let j = i + 1;
      while (j < tokens.length && isNum(tokens[j])) {
        nums.push(Number(tokens[j]));
        j += 1;
      }
      i = j;
      for (let k = 0; k + 5 < nums.length; k += 6) {
        let x1 = nums[k];
        let y1 = nums[k + 1];
        let x2 = nums[k + 2];
        let y2 = nums[k + 3];
        let x = nums[k + 4];
        let y = nums[k + 5];
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        add(x1, y1);
        add(x2, y2);
        add(x, y);
        box.d += ` C${x1} ${y1} ${x2} ${y2} ${x} ${y}`;
        cx = x;
        cy = y;
      }
      continue;
    }
    if (command === "L" || command === "l") {
      const rel = command === "l";
      i += 1;
      while (i + 1 < tokens.length && isNum(tokens[i])) {
        let x = Number(tokens[i]);
        let y = Number(tokens[i + 1]);
        i += 2;
        if (rel) {
          x += cx;
          y += cy;
        }
        add(x, y);
        box.d += ` L${x} ${y}`;
        cx = x;
        cy = y;
      }
      continue;
    }
    if (command === "Z" || command === "z") {
      box.d += " Z";
      cx = sx;
      cy = sy;
      i += 1;
      continue;
    }
    if (command === "H" || command === "h") {
      let x = Number(tokens[i + 1]);
      i += 2;
      if (command === "h") x += cx;
      add(x, cy);
      box.d += ` L${x} ${cy}`;
      cx = x;
      continue;
    }
    if (command === "V" || command === "v") {
      let y = Number(tokens[i + 1]);
      i += 2;
      if (command === "v") y += cy;
      add(cx, y);
      box.d += ` L${cx} ${y}`;
      cy = y;
      continue;
    }
    i += 1;
  }
  if (box) subs.push(box);
  return subs.map((item) => ({
    d: item.d,
    minX: item.minX * 0.1,
    maxX: item.maxX * 0.1,
    minY: 2000 - item.maxY * 0.1,
    maxY: 2000 - item.minY * 0.1,
  }));
}

function roleFor(box) {
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const cy = (box.minY + box.maxY) / 2;
  if (cy > 1620 && width < 80 && height < 80) return "dot";
  if (cy >= 660 && cy <= 1250 && width < 1000) return "word";
  if (width > 900 && cy < 900) return "frame";
  return "banner";
}

function rawSubpaths(d) {
  return String(d || "").match(/[Mm][^Mm]*/g) || [];
}

function recolorEntertainment(svg) {
  const match = svg.match(/<g id="charcoal"[^>]*>\s*<path d="([\s\S]*?)"\s*\/>\s*<\/g>/);
  if (!match) return svg;
  const transform = (svg.match(/<g id="charcoal"[^>]*transform="([^"]+)"/) || [])[1]
    || "translate(0.000000,2000.000000) scale(0.100000,-0.100000)";
  const raw = rawSubpaths(match[1]);
  const boxes = pathBoxes(match[1]);
  if (raw.length !== boxes.length) return svg;
  const groups = { word: [], frame: [], banner: [], dot: [] };
  raw.forEach((part, index) => {
    groups[roleFor(boxes[index])].push(part.replace(/\s+/g, " ").trim());
  });
  const paint = (id, fill, parts) => (
    parts.length
      ? `<g id="${id}" fill="${fill}" fill-rule="evenodd" transform="${transform}"><path d="${parts.join(" ")}"/></g>`
      : ""
  );
  const replacement = [
    paint("charcoal-frame", "#D9D4CC", groups.frame),
    paint("charcoal-word", "#F4EFE4", groups.word),
    paint("charcoal", "#504E50", groups.banner),
    paint("charcoal-dots", "#FFFFFF", groups.dot),
  ].join("");
  return svg.replace(match[0], replacement);
}

function prepareLogoSvg(svg) {
  let text = String(svg || "");
  text = text.replace(/<rect\b[^>]*\bfill="#(?:fff|ffffff|f8f8f5|e5e2da|e8e4dc)"[^>]*\/?>/gi, "");
  // FINANCIAL SERVICES sits on the dark panel. Lighten that path before the mountain recolor.
  text = text.replace(
    /(<g\b[^>]*\bid="subtitle"[^>]*>\s*<path\b[^>]*\bfill="#)[0-9A-Fa-f]{3,8}/,
    "$1C79BD0"
  );
  text = text.replaceAll("#62006E", "#81338B");
  if (text.includes('id="charcoal"')) return recolorEntertainment(text);
  return text.replaceAll("#504E50", "#F4EFE4");
}

module.exports = { prepareLogoSvg, pathBoxes, roleFor };
