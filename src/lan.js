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

module.exports = { getLanIPv4s };
