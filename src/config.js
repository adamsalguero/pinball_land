const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  port: 3000,
  pin: "1234",
};

function loadConfig(configPath = path.join(__dirname, "..", "config.json")) {
  let fileConfig = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    fileConfig = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  const port = Number.parseInt(process.env.PORT || fileConfig.port || DEFAULTS.port, 10);
  const pin = String(process.env.CONTROL_PIN || fileConfig.pin || DEFAULTS.pin);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (!pin) {
    throw new Error("Control PIN cannot be empty. Set it in config.json or CONTROL_PIN.");
  }

  return { port, pin };
}

module.exports = { loadConfig, DEFAULTS };
