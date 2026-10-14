const fs = require("fs");
const path = require("path");

function loadCatalog(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const id = String(item.id || "").trim();
        const holiday = item.holiday === "christmas" || item.holiday === "halloween" ? item.holiday : null;
        const streamUrl = String(item.streamUrl || "");
        if (!/^[a-z0-9-]{3,80}$/.test(id) || !holiday) return null;
        if (!/^https:\/\/(archive\.org|upload\.wikimedia\.org)\//.test(streamUrl)) return null;
        return {
          id,
          title: String(item.title || id).slice(0, 80),
          holiday,
          allAges: item.allAges !== false,
          license: String(item.license || ""),
          sourceUrl: String(item.sourceUrl || ""),
          streamUrl,
          durationSec: Number(item.durationSec) || 0,
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
        };
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code !== "ENOENT") console.error(err.message);
    return [];
  }
}

function starterFile(mediaRoot, item) {
  if (!mediaRoot || !item) return null;
  const folder = path.join(mediaRoot, item.holiday);
  if (!fs.existsSync(folder)) return null;
  for (const ext of [".mp4", ".webm", ".mkv", ".m4v", ".mov"]) {
    const candidate = path.join(folder, `${item.id}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function starterCards(items, { theme, allAges = true, mediaRoot, urlFor } = {}) {
  return (items || [])
    .filter((item) => {
      if (allAges && item.allAges === false) return false;
      return item.holiday === theme;
    })
    .map((item) => {
      const local = starterFile(mediaRoot, item);
      return {
        type: "video",
        id: `starter:${item.id}`,
        starterId: item.id,
        url: local && urlFor ? urlFor(item.id) : item.streamUrl,
        title: item.title,
        loop: false,
        mode: "card",
        stream: !local,
      };
    });
}

module.exports = { loadCatalog, starterFile, starterCards };
