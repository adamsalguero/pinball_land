const { isLanAddress } = require("./lan");

const GUEST_PORT_OFFSET = 10;

const GUEST_FILES = new Set([
  "/guest.css",
  "/guest.js",
  "/machine-gallery.css",
  "/machine-gallery.js",
  "/cabinet-placeholder.png",
  "/design-tokens.css",
  "/manifest.webmanifest",
  "/sw.js",
]);

function headerHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  const colon = raw.lastIndexOf(":");
  if (colon > -1 && raw.indexOf(":") === colon) return raw.slice(0, colon);
  return raw;
}

function isLocalHostName(value) {
  const name = headerHost(value);
  if (!name) return false;
  if (name === "localhost") return true;
  if (isLanAddress(name)) return true;
  if (name.endsWith(".local")) return true;
  if (!name.includes(".")) return true;
  return false;
}

function headerPresent(headers, name) {
  const value = headers?.[name];
  if (value === undefined || value === null) return false;
  return String(value).trim() !== "";
}

function isTunneledRequest(req) {
  const headers = req?.headers || {};
  if (headerPresent(headers, "cf-connecting-ip")) return true;
  if (headerPresent(headers, "cf-ray")) return true;
  if (/cloudflare/i.test(String(headers["cdn-loop"] || ""))) return true;
  if (headerPresent(headers, "tailscale-funnel-request")) return true;
  if (headerPresent(headers, "tailscale-funnel")) return true;
  if (headerPresent(headers, "x-tailscale-funnel")) return true;
  if (headerPresent(headers, "x-forwarded-for")) return true;
  if (headerPresent(headers, "forwarded")) return true;
  if (!isLocalHostName(headers.host)) return true;
  return false;
}

function isGuestRoute(req) {
  const path = String(req?.path || "/").split("?")[0];
  const method = String(req?.method || "GET").toUpperCase();
  if (method === "GET" && (path === "/" || path === "/app")) return true;
  if (method === "GET" && GUEST_FILES.has(path)) return true;
  if (method === "GET" && path.startsWith("/icons/guest-")) return true;
  if (method === "GET" && path === "/api/guest") return true;
  if (method === "GET" && path === "/api/guest-photos/feed") return true;
  if (method === "POST" && path === "/api/guest-photos") return true;
  if (method === "POST" && path === "/api/scores") return true;
  if (method === "GET" && path === "/api/opdb/search") return true;
  if (method === "GET" && /^\/api\/opdb\/cabinet\/[A-Za-z0-9_-]+$/.test(path)) return true;
  if (method === "POST" && path === "/api/opdb/boards") return true;
  if (method === "GET" && /^\/media\/guest\/[0-9a-f-]{36}\.jpg$/i.test(path)) return true;
  return false;
}

function guestPortFor(port) {
  const base = Number(port);
  if (!Number.isFinite(base) || base <= 0) return 3000 + GUEST_PORT_OFFSET;
  return base + GUEST_PORT_OFFSET;
}

module.exports = {
  GUEST_PORT_OFFSET,
  isTunneledRequest,
  isGuestRoute,
  isLocalHostName,
  guestPortFor,
};
