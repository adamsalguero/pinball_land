function acceptYoutube(kind, id) {
  const value = String(id || "");
  if (kind === "video" && /^[A-Za-z0-9_-]{11}$/.test(value)) return { kind, id: value };
  if (kind === "playlist" && /^[A-Za-z0-9_-]{12,80}$/.test(value)) return { kind, id: value };
  return null;
}

function parseYoutubeInput(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  let url = null;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (url) {
    const host = url.hostname.replace(/^www\./, "");
    const list = url.searchParams.get("list");
    const video = url.searchParams.get("v");
    const youtubeHost = host === "youtube.com" || host === "youtube-nocookie.com" || host === "m.youtube.com";
    if (youtubeHost && list && !video) return acceptYoutube("playlist", list);
    if (youtubeHost && video) return acceptYoutube("video", video);
    const parts = url.pathname.split("/").filter(Boolean);
    if (host === "youtu.be" && parts[0]) return acceptYoutube("video", parts[0]);
    if (parts[0] === "embed" && parts[1] && parts[1] !== "videoseries") return acceptYoutube("video", parts[1]);
    if (parts[0] === "playlist" && list) return acceptYoutube("playlist", list);
  }
  return acceptYoutube("playlist", text) || acceptYoutube("video", text);
}

function embedSrc(item) {
  const params = [
    "enablejsapi=1",
    "autoplay=1",
    "mute=1",
    "controls=0",
    "modestbranding=1",
    "rel=0",
    "iv_load_policy=3",
    "playsinline=1",
    "fs=0",
    "disablekb=1",
  ].join("&");
  if (!item) return "";
  if (item.kind === "playlist") {
    return `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(item.id)}&${params}`;
  }
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.id)}?${params}`;
}

function normalizeYoutubeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const parsed = parseYoutubeInput(raw.id) || parseYoutubeInput(raw.url);
  if (!parsed) return null;
  return {
    id: parsed.id,
    kind: parsed.kind,
    title: String(raw.title || (parsed.kind === "playlist" ? "Playlist" : "Video")).trim().slice(0, 80) || "Video",
  };
}

function normalizeYoutubeLists(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const out = { pinnacle: [], halloween: [], christmas: [] };
  for (const theme of Object.keys(out)) {
    const list = Array.isArray(incoming[theme]) ? incoming[theme] : [];
    for (const item of list) {
      const normalized = normalizeYoutubeItem(item);
      if (!normalized) continue;
      if (out[theme].some((entry) => entry.kind === normalized.kind && entry.id === normalized.id)) continue;
      out[theme].push(normalized);
      if (out[theme].length >= 24) break;
    }
  }
  return out;
}

const SKIP_ERROR_CODES = new Set([100, 101, 150]);

module.exports = {
  parseYoutubeInput,
  embedSrc,
  normalizeYoutubeItem,
  normalizeYoutubeLists,
  SKIP_ERROR_CODES,
};
