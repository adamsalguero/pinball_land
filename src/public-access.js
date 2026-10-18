const path = require("path");
const { spawn } = require("child_process");

function parseTailscaleStatus(text) {
  const data = JSON.parse(String(text || ""));
  const dns = String(data?.Self?.DNSName || "").replace(/\.$/, "").toLowerCase();
  if (!dns || !dns.endsWith(".ts.net")) return "";
  if (data?.Self?.Online === false) return "";
  return dns;
}

function parseFunnelStatus(text) {
  if (!String(text || "").trim()) return false;
  const data = JSON.parse(String(text));
  if (!data || typeof data !== "object") return false;
  if (data.Funnel === false || data.AllowFunnel === false) return false;
  const web = data.Web || data.web;
  if (web && typeof web === "object" && Object.keys(web).length) return true;
  const tcp = data.TCP || data.tcp;
  if (tcp && typeof tcp === "object" && Object.keys(tcp).length) return true;
  return data.Funnel === true || data.AllowFunnel === true;
}

function publicUrlFrom(dns, funnelOn) {
  if (!dns || !funnelOn) return "";
  return `https://${String(dns).replace(/\.$/, "")}`;
}

function parseCloudflareLine(line) {
  const match = String(line || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : "";
}

function runCommand(command, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(out);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

async function detectTailscale(runner = runCommand) {
  const status = await runner("tailscale", ["status", "--json"]);
  const funnel = await runner("tailscale", ["funnel", "status", "--json"]);
  let dns = "";
  let on = false;
  try {
    dns = parseTailscaleStatus(status);
  } catch {
    dns = "";
  }
  try {
    on = parseFunnelStatus(funnel);
  } catch {
    on = false;
  }
  const url = publicUrlFrom(dns, on);
  return { url, source: url ? "tailscale" : "" };
}

function startQuickTunnel({ bin, port, onUrl, onError, spawnImpl = spawn } = {}) {
  if (!bin || !path.isAbsolute(bin)) {
    const err = Object.assign(
      new Error("Cloudflare must be started from its downloaded file, not from PATH"),
      { code: "spawn" }
    );
    if (onError) onError(err);
    return null;
  }
  let child;
  try {
    child = spawnImpl(bin, [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${port}`,
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
  if (!child) {
    if (onError) onError(Object.assign(new Error("spawn failed"), { code: "spawn", path: bin }));
    return null;
  }
  const take = (chunk) => {
    const found = parseCloudflareLine(String(chunk || ""));
    if (found && onUrl) onUrl(found);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("error", (err) => {
    if (onError) onError(err);
  });
  return child;
}

module.exports = {
  parseTailscaleStatus,
  parseFunnelStatus,
  publicUrlFrom,
  parseCloudflareLine,
  detectTailscale,
  startQuickTunnel,
  runCommand,
};
