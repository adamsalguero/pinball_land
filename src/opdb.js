const fs = require("fs/promises");
const path = require("path");

const OPDB_BASE = "https://opdb.org/api";
const USER_AGENT = "pinball-land-kiosk";

function safeId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return ".png";
    if (pathname.endsWith(".webp")) return ".webp";
    if (pathname.endsWith(".gif")) return ".gif";
    if (pathname.endsWith(".svg")) return ".svg";
  } catch {
    // ignore
  }
  return ".jpg";
}

function collectImages(machine) {
  const images = [];
  if (Array.isArray(machine?.images)) {
    images.push(...machine.images);
  }
  if (machine?.image) {
    images.push(typeof machine.image === "string" ? { url: machine.image } : machine.image);
  }
  return images;
}

function imageUrl(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  const urls = img.urls || img.sizes || {};
  return urls.large || urls.medium || urls.small || img.url || img.src || null;
}

function imageRank(img) {
  const t = `${img?.type || ""} ${img?.title || ""} ${img?.kind || ""} ${img?.category || ""}`.toLowerCase();
  if (t.includes("backglass")) return 0;
  if (t.includes("translite")) return 1;
  if (t.includes("banner")) return 2;
  if (img?.primary) return 3;
  if (t.includes("cabinet")) return 4;
  if (t.includes("playfield")) return 9;
  return 5;
}

function pickArtUrl(machine) {
  const images = collectImages(machine).slice().sort((a, b) => imageRank(a) - imageRank(b));
  for (const img of images) {
    const url = imageUrl(img);
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function pickVideoUrl(machine) {
  const candidates = [];
  for (const key of ["video_url", "trailer_url", "tutorial_url"]) {
    if (machine?.[key]) candidates.push(machine[key]);
  }
  if (Array.isArray(machine?.videos)) {
    for (const item of machine.videos) {
      candidates.push(typeof item === "string" ? item : item?.url);
    }
  }
  if (Array.isArray(machine?.links)) {
    for (const item of machine.links) {
      const url = typeof item === "string" ? item : item?.url;
      const label = `${item?.type || ""} ${item?.title || ""}`.toLowerCase();
      if (label.includes("video") || label.includes("trailer") || label.includes("tutorial")) {
        candidates.push(url);
      }
    }
  }
  for (const url of candidates) {
    if (url && /^https?:\/\//i.test(url) && /\.(mp4|webm|ogg)(\?|$)/i.test(url)) {
      return url;
    }
  }
  return null;
}

function manufacturerName(machine) {
  const m = machine?.manufacturer;
  if (!m) return "";
  if (typeof m === "string") return m;
  return m.manufacturer_name || m.name || "";
}

function manufactureYear(machine) {
  const raw = machine?.manufacture_date || machine?.year || machine?.date || "";
  const match = String(raw).match(/(18|19|20)\d{2}/);
  return match ? match[0] : "";
}

function normalizeTypeahead(data) {
  return (Array.isArray(data) ? data : []).map((item) => ({
    opdbId: item.id || item.opdb_id || "",
    name: item.name || item.text || "Unknown machine",
    detail: item.supplementary || item.text || "",
  })).filter((item) => item.opdbId || item.name);
}

function normalizeSearch(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  return list.map((item) => ({
    opdbId: item.opdb_id || item.id || "",
    name: item.name || "Unknown machine",
    detail: [manufacturerName(item), manufactureYear(item)].filter(Boolean).join(", "),
    machine: item,
  })).filter((item) => item.opdbId || item.name);
}

function createOpdb({ apiKey = "", cacheDir, fetchImpl } = {}) {
  const key = String(apiKey || "").trim();
  const fetchFn = fetchImpl || globalThis.fetch;

  async function getJson(urlPath, { auth = false } = {}) {
    const headers = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (auth) {
      if (!key) {
        const err = new Error("OPDB API token is not configured");
        err.status = 400;
        throw err;
      }
      headers.Authorization = `Bearer ${key}`;
    }
    const res = await fetchFn(`${OPDB_BASE}/${urlPath.replace(/^\//, "")}`, { headers });
    if (!res.ok) {
      const err = new Error(`OPDB request failed (${res.status})`);
      err.status = 502;
      err.opdbStatus = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    configured: Boolean(key),

    async search(query) {
      const q = String(query || "").trim();
      if (q.length < 2) return [];
      if (key) {
        try {
          const data = await getJson(`search?q=${encodeURIComponent(q)}`, { auth: true });
          const rows = normalizeSearch(data);
          if (rows.length) return rows;
        } catch {
          // Typeahead still works without a token / if search is denied.
        }
      }
      const data = await getJson(`search/typeahead?q=${encodeURIComponent(q)}`);
      return normalizeTypeahead(data);
    },

    async getMachine(opdbId) {
      const id = safeId(opdbId);
      if (!id || !key) return null;
      return getJson(`machines/${encodeURIComponent(id)}`, { auth: true });
    },

    async cacheMachine(opdbId) {
      const id = safeId(opdbId);
      if (!id || !cacheDir || !key) {
        return { machine: null, artFile: null, videoUrl: null };
      }
      const dir = path.join(cacheDir, id);
      await fs.mkdir(dir, { recursive: true });
      const machine = await this.getMachine(id);
      if (!machine) {
        return { machine: null, artFile: null, videoUrl: null };
      }
      await fs.writeFile(path.join(dir, "machine.json"), JSON.stringify(machine, null, 2));
      let artFile = null;
      const artUrl = pickArtUrl(machine);
      if (artUrl) {
        try {
          const res = await fetchFn(artUrl, { headers: { "User-Agent": USER_AGENT } });
          if (res.ok) {
            const ext = extFromUrl(artUrl);
            const dest = path.join(dir, `art${ext}`);
            await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
            artFile = path.join(id, `art${ext}`);
          }
        } catch {
          // Wall still works from typed-in scores if art cannot be fetched.
        }
      }
      return { machine, artFile, videoUrl: pickVideoUrl(machine) };
    },
  };
}

module.exports = {
  OPDB_BASE,
  createOpdb,
  pickArtUrl,
  pickVideoUrl,
  manufacturerName,
  manufactureYear,
  safeId,
  normalizeTypeahead,
  normalizeSearch,
};
