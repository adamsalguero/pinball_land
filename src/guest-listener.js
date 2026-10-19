const http = require("http");
const fs = require("fs");
const path = require("path");

function appendTunnelLog(logFile, line) {
  const text = String(line || "").trim();
  if (!logFile || !text) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // The next line tries again.
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

function closeQuiet(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.close !== "function") return resolve();
    server.close(() => resolve());
  });
}

function guestDownMessage(port, errors) {
  const reason = (errors || []).filter(Boolean).join("; ") || "the port did not open";
  return `Guest port ${port} is not listening (${reason}). Public guests cannot connect until this port is open.`;
}

function tune(server) {
  if (!server || typeof server !== "object") return;
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 20000;
  server.requestTimeout = 60000;
}

async function openGuestPort(requestListener, port, {
  logFile,
  listenImpl = listen,
  createServerImpl = (handler) => http.createServer(handler),
} = {}) {
  const errors = [];
  for (const host of ["0.0.0.0", "127.0.0.1"]) {
    const server = createServerImpl(requestListener);
    tune(server);
    try {
      await listenImpl(server, port, host);
      if (typeof server.on === "function") {
        server.on("error", (err) => {
          appendTunnelLog(logFile, `guest error ${host}:${port} ${err.code || ""} ${err.message}`);
        });
      }
      appendTunnelLog(logFile, `guest listening ${host}:${port}`);
      return { server, host, port, listening: true, error: "" };
    } catch (err) {
      const text = `${err.code || "error"} ${err.message || err}`.trim();
      errors.push(`${host} ${text}`);
      appendTunnelLog(logFile, `guest listen error ${host}:${port} ${text}`);
      await closeQuiet(server);
    }
  }
  const error = guestDownMessage(port, errors);
  appendTunnelLog(logFile, `guest down ${error}`);
  return { server: null, host: "", port, listening: false, error };
}

function createGuestListener({ logFile, listenImpl, createServerImpl } = {}) {
  let current = { server: null, host: "", port: 0, listening: false, error: "" };
  let pending = null;

  function held(port) {
    return current.listening && current.port === port && current.server && current.server.listening !== false;
  }

  async function ensure(requestListener, port) {
    const next = Number(port);
    if (held(next)) return current;
    if (pending) return pending;
    const previous = current.server;
    pending = openGuestPort(requestListener, next, { logFile, listenImpl, createServerImpl })
      .then(async (result) => {
        if (previous && previous !== result.server) await closeQuiet(previous);
        current = result;
        return current;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  return {
    ensure,
    status: () => current,
  };
}

module.exports = {
  createGuestListener,
  openGuestPort,
  appendTunnelLog,
  guestDownMessage,
};
