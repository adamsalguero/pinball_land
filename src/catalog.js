const fs = require("fs");
const path = require("path");

const STREAM_HOSTS = /^https:\/\/(archive\.org|upload\.wikimedia\.org)\//;
const REMOVED_STARTER_IDS = ["santas-surprise-1947", "good-will-to-men-1955", "swing-you-sinners-1930"];

function removedStarterId(id) {
  const bare = String(id || "").replace(/^starter:/, "");
  return REMOVED_STARTER_IDS.includes(bare);
}

function purgeRemovedStarters(dir) {
  const removed = [];
  if (!dir || !fs.existsSync(dir)) return removed;
  for (const id of REMOVED_STARTER_IDS) {
    for (const name of [id, `${id}.mp4`, `${id}.mp4.part`, `${id}.part`, `${id}.tmp.mp4`, `${id}.partial`]) {
      const file = path.join(dir, name);
      try {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        fs.unlinkSync(file);
        removed.push(file);
      } catch {
        // A locked cache file is tried again on the next startup.
      }
    }
  }
  return removed;
}

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
        if (removedStarterId(id)) return null;
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

function starterCards(items, { theme, allAges = true, urlFor, disabledIds = [], isReady } = {}) {
  const disabled = new Set(disabledIds || []);
  if (theme !== "halloween" && theme !== "christmas") return [];
  return (items || [])
    .filter((item) => {
      if (removedStarterId(item.id)) return false;
      if (disabled.has(item.id)) return false;
      if (allAges && item.allAges === false) return false;
      if (item.holiday === "christmas" && item.color !== true) return false;
      if (item.holiday !== theme) return false;
      return typeof isReady === "function" && isReady(item.id);
    })
    .map((item) => ({
      type: "video",
      id: `starter:${item.id}`,
      starterId: item.id,
      url: urlFor ? urlFor(item.id) : "",
      title: item.title,
      loop: false,
      mode: "card",
      stream: false,
      local: true,
      durationSec: item.durationSec,
      holiday: item.holiday,
      color: item.color === true,
    }))
    .filter((card) => card.url);
}

module.exports = {
  loadCatalog,
  starterFile,
  starterCards,
  catalogProblems,
  STREAM_HOSTS,
  REMOVED_STARTER_IDS,
  removedStarterId,
  purgeRemovedStarters,
};
