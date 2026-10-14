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
    if ((host === "youtube.com" || host === "youtube-nocookie.com" || host === "m.youtube.com") && list && !video) {
      return { kind: "playlist", id: list };
    }
    if ((host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") && video) {
      return { kind: "video", id: video };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (host === "youtu.be" && parts[0]) return { kind: "video", id: parts[0].slice(0, 32) };
    if (parts[0] === "embed" && parts[1] && parts[1] !== "videoseries") return { kind: "video", id: parts[1] };
    if (parts[0] === "playlist" && list) return { kind: "playlist", id: list };
  }
  if (/^PL[\w-]{8,}$/.test(text) || /^OLAK5uy[\w-]{8,}$/.test(text)) return { kind: "playlist", id: text };
  if (/^[\w-]{11}$/.test(text)) return { kind: "video", id: text };
  return null;
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
  const kind = raw.kind === "playlist" || raw.kind === "video" ? raw.kind : parsed?.kind;
  const id = String(raw.id || parsed?.id || "").trim();
  if (!kind || !id || id.length > 80) return null;
  return {
    id,
    kind,
    title: String(raw.title || (kind === "playlist" ? "Playlist" : "Video")).trim().slice(0, 80) || "Video",
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
