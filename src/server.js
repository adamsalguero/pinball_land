const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { createApp } = require("./app");
const { createConfigStore } = require("./config");
const { Store } = require("./store");
const { getLanIPv4s } = require("./lan");
const { ensureCertificate } = require("./certs");
const { slotLabel } = require("./displays");
const { defaultDataDir, dataLayout, migrateData, resolveDataDir } = require("./paths");

function printBanner(config, httpsReady) {
  const port = config.port;
  console.log("");
  console.log("Pinball Land kiosk is running");
  console.log("--------------------------------");
  console.log(`Guest app:           http://localhost:${port}/`);
  console.log(`Admin app:           http://localhost:${port}/admin`);
  const ips = getLanIPv4s();
  if (ips.length) {
    for (const ip of ips) {
      console.log(`Guest phone:         http://${ip}:${port}/`);
      console.log(`Admin iPad:          http://${ip}:${port}/admin`);
    }
  } else {
    console.log("Phones:              (no LAN IPv4 found — connect to WiFi and restart)");
  }
  for (let slot = 1; slot <= config.displays.count; slot += 1) {
    const label = slotLabel(slot, config.displays.count);
    console.log(`${label} display:`.padEnd(21) + `http://localhost:${port}/display/${slot}`);
  }
  console.log(`Admin PIN:           set in the data-dir config (default 2224)`);
  console.log(`Reset PIN:           npm run reset-pin`);
  if (httpsReady) {
    console.log(`Browser share:       https://<this-pc>:${config.httpsPort}/present`);
    console.log("                     Guests must accept the certificate warning once.");
  } else {
    console.log("Browser share:       HTTPS did not start. Screen share needs it. See PRESENTING.md.");
  }
  console.log("--------------------------------");
  console.log("Listening on 0.0.0.0 so other devices on this WiFi can connect.");
  console.log("Wall TVs:            npm run kiosk   (windows for enabled displays)");
  console.log("");
}

async function startHttps({ app, attachWebSocket, config, certDir }) {
  if (!config.httpsPort || config.httpsPort === config.port) {
    console.warn("HTTPS port disabled. Browser screen share will not work until HTTPS is on.");
    return null;
  }
  const hosts = ["localhost", "127.0.0.1", ...getLanIPv4s()];
  const cert = await ensureCertificate({ certDir, hosts });
  if (cert.error || !cert.certPath) {
    console.warn(`Browser share needs HTTPS, and the certificate was not created (${cert.error || "unknown error"}).`);
    console.warn("Control and rotation still work over HTTP. See PRESENTING.md.");
    return null;
  }
  const server = https.createServer(
    {
      cert: fs.readFileSync(cert.certPath),
      key: fs.readFileSync(cert.keyPath),
    },
    app
  );
  attachWebSocket(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpsPort, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  console.log(`HTTPS for browser share is on port ${config.httpsPort}.`);
  return server;
}

const SERVER_LOG = "server.log";
let activeDataDir = null;

function addrInUseMessage(port) {
  return `Another server is already listening on port ${port}. Pinball Land did not start a second copy. Close the other npm start window, or end that node.exe in Task Manager, then start again.`;
}

function reportListenError(err, port, log = console.error) {
  if (err && err.code === "EADDRINUSE") log(addrInUseMessage(port));
  return err;
}

async function logStartupFailure(err, logsDir) {
  const dir = logsDir || dataLayout(activeDataDir || defaultDataDir()).logs;
  await fs.promises.mkdir(dir, { recursive: true });
  const body = err && err.stack ? err.stack : String(err);
  const file = path.join(dir, SERVER_LOG);
  await fs.promises.appendFile(file, `[${new Date().toISOString()}] ${body}\n`, "utf8");
  return file;
}

async function launchServer() {
  const root = path.join(__dirname, "..");
  activeDataDir = await resolveDataDir();
  const migrated = await migrateData({ appRoot: root, dataDir: activeDataDir });
  const paths = dataLayout(migrated.dataDir);
  if (!fs.existsSync(paths.config)) {
    await fs.promises.copyFile(path.join(root, "config.json"), paths.config);
  }
  const configStore = createConfigStore(paths.config);
  const config = configStore.get();
  const store = await Store.load(paths.state);
  let httpsReady = false;
  const { app, attachWebSocket } = createApp({
    store,
    pin: config.pin,
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
    photosDir: path.join(root, "public", "photos"),
    opdbApiKey: config.opdbApiKey,
    cacheDir: paths.opdb,
    uploadsDir: paths.uploads,
    mediaDir: paths.media,
    mediaCatalog: paths.mediaCatalog,
    devicesPath: paths.devices,
    guestPhotosDir: paths.photos,
    catalogPath: path.join(root, "media", "catalog.json"),
    dataDir: migrated.dataDir,
    appRoot: root,
    clipCache: process.env.PINBALL_CLIP_CACHE !== "0",
    configStore,
    isHttpsReady: () => httpsReady,
  });

  const server = http.createServer(app);
  attachWebSocket(server);

  await new Promise((resolve, reject) => {
    server.once("error", (err) => {
      reportListenError(err, config.port);
      reject(err);
    });
    server.listen(config.port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  try {
    const httpsServer = await startHttps({
      app,
      attachWebSocket,
      config,
      certDir: paths.certs,
    });
    httpsReady = Boolean(httpsServer);
  } catch (err) {
    console.warn(`HTTPS did not start (${err.message}). Browser screen share needs it. See PRESENTING.md.`);
  }

  printBanner(config, httpsReady);
  return { server, port: config.port, config, httpsReady };
}

async function startServer() {
  try {
    return await launchServer();
  } catch (err) {
    console.error(err);
    try {
      const file = await logStartupFailure(err);
      console.error(`Startup failure written to ${file}`);
    } catch (logErr) {
      console.error(`Could not write the server log: ${logErr.message}`);
    }
    throw err;
  }
}

if (require.main === module) {
  startServer().catch(() => {
    process.exit(1);
  });
}

module.exports = { startServer, printBanner, logStartupFailure, addrInUseMessage, reportListenError };
