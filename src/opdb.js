const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");

const OPDB_BASE = "https://opdb.org/api";
const EXPORT_URL = "https://mp-data.sfo3.cdn.digitaloceanspaces.com/opdb-v2.json";
const BUNDLED_CATALOG = path.join(__dirname, "..", "media", "opdb-catalog.json.gz");
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const sharedCatalogs = new Map();
const sharedCatalogFlights = new Map();
const USER_AGENT = "pinball-land-kiosk";
// Adam's free OPDB token. config.json opdbApiKey and OPDB_API_KEY override it.
const BUILTIN_OPDB_API_KEY = "f5NGaIVP6ojClmDXdbUwj8LPTTp69jGwYVaPtenJMOQhPNVO5GaqLcMNmKvy";

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

function imageText(img) {
  return `${img?.type || ""} ${img?.title || ""} ${img?.kind || ""} ${img?.category || ""}`.toLowerCase();
}

function pickTypedUrl(machine, includes) {
  for (const img of collectImages(machine)) {
    const text = imageText(img);
    if (!includes.some((word) => text.includes(word))) continue;
    const url = imageUrl(img);
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function pickPlayfieldUrl(machine) {
  return pickTypedUrl(machine, ["playfield"]);
}

function pickCabinetUrl(machine) {
  for (const img of collectImages(machine)) {
    const text = imageText(img);
    if (!text.includes("cabinet")) continue;
    if (text.includes("backglass") || text.includes("translite")) continue;
    const url = imageUrl(img);
    if (url && /^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function editionFrom(machine) {
  const features = Array.isArray(machine?.features) ? machine.features : [];
  const names = [];
  for (const feature of features) {
    if (String(feature?.group || "").toLowerCase() !== "edition") continue;
    const name = String(feature?.name || "").trim();
    if (name) names.push(name);
  }
  if (names.length) return names.join(", ");
  const match = String(machine?.name || "").match(/\(([^)]+)\)\s*$/);
  return match ? match[1].trim() : "";
}

function isPhysicalMachine(item) {
  if (!item || typeof item !== "object") return false;
  if (item.physicalMachine === false || item.physical_machine === false) return false;
  const type = String(item.entryType || item.entry_type || item.type || "").toLowerCase();
  // Match Play stores Pro as a machine and Premium, LE, and anniversary editions as aliases.
  if (type === "machinegroup" || type === "group") return false;
  if (item.physicalMachine === true || item.physical_machine === true) return true;
  return type === "machine" || type === "alias" || type === "";
}

function entriesFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.entries)) return data.entries;
  return [];
}

function pickLogoUrl(machine) {
  return pickTypedUrl(machine, ["logo", "backglass logo", "manufacturer logo"]);
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
  const cabinetMisses = new Set();
  let catalogEntries = null;
  let catalogAt = 0;
  let catalogFlight = null;

  async function refreshCatalog() {
    const file = cacheDir ? path.join(cacheDir, "catalog.json") : null;
    const source = String(process.env.PINBALL_OPDB_EXPORT || EXPORT_URL);
    const localExport = !/^https?:\/\//i.test(source);
    if (!localExport && file) {
      try {
        const stat = await fs.stat(file);
        if (Date.now() - stat.mtimeMs < CATALOG_MAX_AGE_MS) {
          const entries = entriesFrom(JSON.parse(await fs.readFile(file, "utf8")));
          if (entries.length) {
            catalogEntries = entries;
            catalogAt = Date.now();
            return catalogEntries;
          }
        }
      } catch {
        // Download a fresh catalog below.
      }
    }
    try {
      let parsed;
      if (localExport) {
        parsed = JSON.parse(await fs.readFile(source, "utf8"));
      } else {
        const res = await fetchFn(source, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error("catalog");
        parsed = await res.json();
      }
      const entries = entriesFrom(parsed);
      if (!entries.length) throw new Error("catalog");
      catalogEntries = entries;
      catalogAt = Date.now();
      if (file && !localExport) {
        try {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, JSON.stringify({ entries }));
        } catch {
          // A locked data dir must not hide a catalog that already loaded.
        }
      }
      return catalogEntries;
    } catch {
      if (catalogEntries?.length) return catalogEntries;
      if (file) {
        try {
          const entries = entriesFrom(JSON.parse(await fs.readFile(file, "utf8")));
          if (entries.length) {
            catalogEntries = entries;
            catalogAt = Date.now();
            return catalogEntries;
          }
        } catch {
          // No catalog yet.
        }
      }
      try {
        const gz = await fs.readFile(BUNDLED_CATALOG);
        const entries = entriesFrom(JSON.parse(zlib.gunzipSync(gz).toString("utf8")));
        if (entries.length) {
          catalogEntries = entries;
          catalogAt = Date.now();
          return catalogEntries;
        }
      } catch {
        // The bundled export is missing.
      }
      return catalogEntries || [];
    }
  }

  function loadCatalog() {
    if (catalogEntries && Date.now() - catalogAt < CATALOG_MAX_AGE_MS) return Promise.resolve(catalogEntries);
    if (catalogFlight) return catalogFlight;
    const source = String(process.env.PINBALL_OPDB_EXPORT || EXPORT_URL);
    const share = !fetchImpl && /^https?:\/\//i.test(source);
    if (share) {
      const cached = sharedCatalogs.get(source);
      if (cached && Date.now() - cached.at < CATALOG_MAX_AGE_MS) {
        catalogEntries = cached.entries;
        catalogAt = cached.at;
        return Promise.resolve(catalogEntries);
      }
      if (sharedCatalogFlights.has(source)) return sharedCatalogFlights.get(source);
    }
    catalogFlight = refreshCatalog().then((entries) => {
      if (share && entries.length) sharedCatalogs.set(source, { entries, at: Date.now() });
      return entries;
    }).finally(() => {
      catalogFlight = null;
      if (share) sharedCatalogFlights.delete(source);
    });
    if (share) sharedCatalogFlights.set(source, catalogFlight);
    return catalogFlight;
  }

  async function catalogMachine(opdbId) {
    const id = safeId(opdbId);
    if (!id) return null;
    const entries = await loadCatalog();
    return entries.find((item) => safeId(item.opdbId || item.opdb_id || item.id) === id) || null;
  }

  function compactMachine(item) {
    const opdbId = safeId(item?.opdbId || item?.opdb_id || item?.id);
    if (!opdbId) return null;
    const name = String(item.name || "Unknown machine");
    const manufacturer = manufacturerName(item);
    const year = manufactureYear(item);
    const edition = editionFrom(item);
    return {
      opdbId,
      name,
      manufacturer,
      year,
      edition,
      cabinet: Boolean(pickCabinetUrl(item)),
      detail: [manufacturer, year, edition].filter(Boolean).join(", "),
    };
  }

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
    const res = await fetchFn(`${OPDB_BASE}/${urlPath.replace(/^\//, "")}`, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
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
      const q = String(query || "").trim().toLowerCase();
      if (q.length < 2) return [];
      let entries = [];
      try {
        entries = await loadCatalog();
      } catch {
        return [];
      }
      const results = [];
      for (const item of entries) {
        if (!isPhysicalMachine(item)) continue;
        const row = compactMachine(item);
        if (!row) continue;
        const blob = [
          row.name,
          row.manufacturer,
          row.edition,
          item.shortname || item.shortName || "",
          item.commonName || item.common_name || "",
        ].join(" ").toLowerCase();
        if (!blob.includes(q)) continue;
        results.push(row);
        if (results.length >= 24) break;
      }
      return results;
    },

    async lookup(opdbId) {
      const machine = await catalogMachine(opdbId);
      return machine ? compactMachine(machine) : null;
    },

    async getMachine(opdbId) {
      const id = safeId(opdbId);
      if (!id || !key) return null;
      return getJson(`machines/${encodeURIComponent(id)}`, { auth: true });
    },

    async cabinetFile(opdbId) {
      const id = safeId(opdbId);
      if (!id || !cacheDir || cabinetMisses.has(id)) return null;
      const dir = path.join(cacheDir, id);
      try {
        const names = await fs.readdir(dir);
        const hit = names.find((name) => /^cabinet\.(png|jpe?g|webp|gif)$/i.test(name));
        if (hit) return path.join(dir, hit);
      } catch {
        // Not cached yet.
      }
      const machine = await catalogMachine(id);
      if (!machine) return null;
      const url = pickCabinetUrl(machine);
      if (!url) {
        cabinetMisses.add(id);
        return null;
      }
      try {
        await fs.mkdir(dir, { recursive: true });
        const res = await fetchFn(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          cabinetMisses.add(id);
          return null;
        }
        const ext = extFromUrl(url);
        const dest = path.join(dir, `cabinet${ext}`);
        await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
        return dest;
      } catch {
        cabinetMisses.add(id);
        return null;
      }
    },

    async cacheMachine(opdbId) {
      const id = safeId(opdbId);
      const empty = { machine: null, artFile: null, playfieldFile: null, logoFile: null, imageFiles: [], videoUrl: null, cabinetFile: null };
      if (!id || !cacheDir) return empty;
      const dir = path.join(cacheDir, id);
      await fs.mkdir(dir, { recursive: true });
      let machine = await catalogMachine(id);
      if (!machine && key) {
        try {
          machine = await this.getMachine(id);
        } catch {
          machine = null;
        }
      }
      if (!machine) return empty;
      await fs.writeFile(path.join(dir, "machine.json"), JSON.stringify(machine, null, 2));
      async function saveNamed(url, stem) {
        if (!url) return null;
        try {
          const res = await fetchFn(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) return null;
          const ext = extFromUrl(url);
          const dest = path.join(dir, `${stem}${ext}`);
          await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
          return path.join(id, `${stem}${ext}`);
        } catch {
          return null;
        }
      }
      const artFile = await saveNamed(pickArtUrl(machine), "art");
      const playfieldFile = await saveNamed(pickPlayfieldUrl(machine), "playfield");
      const logoFile = await saveNamed(pickLogoUrl(machine), "logo");
      const cabinetFile = await saveNamed(pickCabinetUrl(machine), "cabinet");
      const imageFiles = [];
      const images = collectImages(machine).slice(0, 12);
      for (let i = 0; i < images.length; i += 1) {
        const saved = await saveNamed(imageUrl(images[i]), `image-${i}`);
        if (saved) imageFiles.push(saved);
      }
      return { machine, artFile, playfieldFile, logoFile, imageFiles, videoUrl: pickVideoUrl(machine), cabinetFile };
    },
  };
}

module.exports = {
  OPDB_BASE,
  EXPORT_URL,
  BUILTIN_OPDB_API_KEY,
  createOpdb,
  pickArtUrl,
  pickCabinetUrl,
  pickPlayfieldUrl,
  pickLogoUrl,
  pickVideoUrl,
  editionFrom,
  manufacturerName,
  manufactureYear,
  safeId,
  normalizeTypeahead,
  normalizeSearch,
};
