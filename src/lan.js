const os = require("os");

function getLanIPv4s() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = net.family === "IPv4" || net.family === 4;
      if (family && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

function normalizeIp(address) {
  let ip = String(address || "").trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  return ip;
}

function isLoopback(address) {
  const ip = normalizeIp(address);
  return ip === "127.0.0.1" || ip === "::1";
}

function isLanAddress(address) {
  const ip = normalizeIp(address);
  if (!ip) return false;
  if (isLoopback(ip)) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  const v4 = ip.match(/^172\.(\d+)\./);
  if (v4) {
    const second = Number(v4[1]);
    if (second >= 16 && second <= 31) return true;
  }
  const tailscale = ip.match(/^100\.(\d+)\./);
  if (tailscale) {
    const second = Number(tailscale[1]);
    if (second >= 64 && second <= 127) return true;
  }
  if (ip.startsWith("fe80:")) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

function clientAddress(req) {
  return req.socket?.remoteAddress || req.ip || "";
}

function lanRequired(req, res, next) {
  if (isLanAddress(clientAddress(req))) return next();
  const message = "Presenting is only available on this local network.";
  if (String(req.path || "").startsWith("/api/")) {
    return res.status(403).json({ error: message });
  }
  return res.status(403).type("text/plain").send(message);
}

function loopbackRequired(req, res, next) {
  if (isLoopback(clientAddress(req))) return next();
  return res.status(403).json({ error: "This endpoint is only available on the kiosk PC." });
}

module.exports = {
  getLanIPv4s,
  normalizeIp,
  isLoopback,
  isLanAddress,
  lanRequired,
  loopbackRequired,
};
