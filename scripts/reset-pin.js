const path = require("path");
const { defaultDataDir, dataLayout } = require("../src/paths");
const { writeDefaultPin } = require("../src/config");
const { DEFAULT_PIN } = require("../src/devices");

const target = process.argv[2] ? path.resolve(process.argv[2]) : dataLayout(defaultDataDir()).config;
writeDefaultPin(target);
console.log(`PIN reset to ${DEFAULT_PIN} in ${target}`);
console.log("The running server reads the file on the next login. No restart required.");
