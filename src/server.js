const http = require("http");
const path = require("path");
const { createApp } = require("./app");
const { loadConfig } = require("./config");
const { Store } = require("./store");
const { getLanIPv4s } = require("./lan");

async function main() {
  const root = path.join(__dirname, "..");
  const config = loadConfig(path.join(root, "config.json"));
  const store = await Store.load(path.join(root, "data", "state.json"));
  const { app, attachWebSocket } = createApp({
    store,
    pin: config.pin,
    publicDir: path.join(root, "public"),
    logosDir: path.join(root, "public", "logos"),
  });

  const server = http.createServer(app);
  attachWebSocket(server);

  server.listen(config.port, "0.0.0.0", () => {
    const port = config.port;
    console.log("");
    console.log("Pinball Land kiosk is running");
    console.log("--------------------------------");
    console.log(`This PC control:     http://localhost:${port}/`);
    const ips = getLanIPv4s();
    if (ips.length) {
      for (const ip of ips) {
        console.log(`Phone / iPad:        http://${ip}:${port}/`);
      }
    } else {
      console.log("Phone / iPad:        (no LAN IPv4 found — connect to WiFi and restart)");
    }
    console.log(`Left display:        http://localhost:${port}/display/1`);
    console.log(`Center display:      http://localhost:${port}/display/2`);
    console.log(`Right display:       http://localhost:${port}/display/3`);
    console.log(`Control PIN:         set in config.json (default 1234)`);
    console.log("--------------------------------");
    console.log("Listening on 0.0.0.0 so other devices on this WiFi can connect.");
    console.log("");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
