function displayOrigins({ port, ipv6 = true, extraPort = null } = {}) {
  const third = ipv6
    ? `http://[::1]:${port}`
    : `http://127.0.0.1:${extraPort || port}`;
  return {
    1: `http://localhost:${port}`,
    2: `http://127.0.0.1:${port}`,
    3: third,
  };
}

function originHost(url) {
  return new URL(url).host;
}

async function probeOrigin(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(1500) });
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

async function discoverDisplayOrigins(port, fetchImpl = globalThis.fetch) {
  if (await probeOrigin(`http://[::1]:${port}/api/health`, fetchImpl)) {
    return displayOrigins({ port, ipv6: true });
  }
  const extra = Number(port) + 1;
  if (await probeOrigin(`http://127.0.0.1:${extra}/api/health`, fetchImpl)) {
    return displayOrigins({ port, ipv6: false, extraPort: extra });
  }
  return displayOrigins({ port, ipv6: false, extraPort: port });
}

module.exports = {
  displayOrigins,
  originHost,
  probeOrigin,
  discoverDisplayOrigins,
};
