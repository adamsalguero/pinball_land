const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");

function classifyHost(host) {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || String(host).includes(":")) return "ip";
  return "dns";
}

function buildSanConfig(hosts) {
  const dns = [];
  const ips = [];
  for (const host of hosts || []) {
    if (!host) continue;
    if (classifyHost(host) === "ip") ips.push(host);
    else dns.push(host);
  }
  if (!dns.includes("localhost")) dns.unshift("localhost");
  if (!ips.includes("127.0.0.1")) ips.unshift("127.0.0.1");
  const alt = [...dns.map((host) => `DNS:${host}`), ...ips.map((host) => `IP:${host}`)];
  return [
    "[req]",
    "distinguished_name = dn",
    "x509_extensions = v3_req",
    "prompt = no",
    "[dn]",
    "CN = pinball-land",
    "[v3_req]",
    "basicConstraints = CA:FALSE",
    "keyUsage = digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = ${alt.join(",")}`,
    "",
  ].join("\n");
}

function sameHostList(left, right) {
  const a = [...left].filter(Boolean).sort();
  const b = [...right].filter(Boolean).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function defaultExec(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        const wrapped = new Error(stderr || err.message || "openssl failed");
        wrapped.code = err.code;
        reject(wrapped);
        return;
      }
      resolve(stdout);
    });
  });
}

function altNames(hosts) {
  const names = [];
  for (const host of hosts) {
    if (!host) continue;
    if (classifyHost(host) === "ip") names.push({ type: 7, ip: host });
    else names.push({ type: 2, value: host });
  }
  return names;
}

function generateWithSelfsigned(hosts) {
  const selfsigned = require("selfsigned");
  return selfsigned.generate([{ name: "commonName", value: "pinball-land" }], {
    algorithm: "sha256",
    days: 825,
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: altNames(hosts) },
    ],
  });
}

async function ensureCertificate({ certDir, hosts, execImpl = defaultExec } = {}) {
  const wanted = [...new Set((hosts || []).filter(Boolean))];
  if (!wanted.includes("localhost")) wanted.unshift("localhost");
  if (!wanted.includes("127.0.0.1")) wanted.push("127.0.0.1");
  const certPath = path.join(certDir, "cert.pem");
  const keyPath = path.join(certDir, "key.pem");
  const sanPath = path.join(certDir, "san.txt");
  try {
    const [previous, cert, key] = await Promise.all([
      fs.readFile(sanPath, "utf8"),
      fs.readFile(certPath),
      fs.readFile(keyPath),
    ]);
    const saved = previous.split(/\s+/).filter(Boolean);
    if (cert.length && key.length && sameHostList(saved, wanted)) {
      return { certPath, keyPath, created: false };
    }
  } catch {
    // Generate a new certificate.
  }

  await fs.mkdir(certDir, { recursive: true });
  try {
    const pems = generateWithSelfsigned(wanted);
    await fs.writeFile(keyPath, pems.private, "utf8");
    await fs.writeFile(certPath, pems.cert, "utf8");
  } catch (selfsignedError) {
    const cnfPath = path.join(certDir, "san.cnf");
    await fs.writeFile(cnfPath, buildSanConfig(wanted), "utf8");
    try {
      await execImpl("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "825",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-config",
        cnfPath,
      ]);
    } catch (err) {
      return {
        error: selfsignedError.message || (err.code === "ENOENT" ? "could not create a certificate" : err.message),
      };
    }
  }
  await fs.writeFile(sanPath, `${wanted.join("\n")}\n`, "utf8");
  return { certPath, keyPath, created: true };
}

module.exports = {
  buildSanConfig,
  ensureCertificate,
  sameHostList,
};
