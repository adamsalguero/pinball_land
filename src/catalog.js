const fs = require("fs");
const path = require("path");

const STREAM_HOSTS = /^https:\/\/(archive\.org|upload\.wikimedia\.org)\//;

function catalogProblems(items) {
  const problems = [];
  const ids = new Set();
  const urls = new Set();
  for (const item of items || []) {
    const id = String(item?.id || "");
    if (!/^[a-z0-9-]{3,80}$/.test(id)) problems.push(`bad id: ${id || "(missing)"}`);
    else if (ids.has(id)) problems.push(`duplicate id: ${id}`);
    else ids.add(id);
    const holiday = item?.holiday;
    if (holiday !== "halloween" && holiday !== "christmas") problems.push(`${id || "item"} has no holiday`);
    const streamUrl = String(item?.streamUrl || "");
    if (!STREAM_HOSTS.test(streamUrl)) problems.push(`${id} stream is not an allowed https host`);
    else if (urls.has(streamUrl)) problems.push(`duplicate stream: ${id}`);
    else urls.add(streamUrl);
    if (!String(item?.title || "").trim()) problems.push(`${id} needs a title`);
    if (!(Number(item?.durationSec) > 0)) problems.push(`${id} needs durationSec`);
    if (holiday === "christmas" && item?.color !== true) problems.push(`${id} Christmas video must be color`);
  }
  return problems;
}

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
        if (!STREAM_HOSTS.test(streamUrl)) return null;
        if (holiday === "christmas" && item.color !== true) return null;
        return {
          id,
          title: String(item.title || id).slice(0, 80),
          holiday,
          allAges: item.allAges !== false,
          color: item.color === true,
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

function starterCards(items, { theme, allAges = true, mediaRoot, urlFor, disabledIds = [] } = {}) {
  const disabled = new Set(disabledIds || []);
  return (items || [])
    .filter((item) => {
      if (disabled.has(item.id)) return false;
      if (allAges && item.allAges === false) return false;
      if (item.holiday === "christmas" && item.color !== true) return false;
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
        durationSec: item.durationSec,
        holiday: item.holiday,
        color: item.color === true,
      };
    });
}

module.exports = { loadCatalog, starterFile, starterCards, catalogProblems, STREAM_HOSTS };
