const fsp = require("fs/promises");
const path = require("path");

function clockToMinutes(clock) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function inQuietWindow(date, start, end) {
  const on = clockToMinutes(start);
  const off = clockToMinutes(end);
  if (on == null || off == null || on === off) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  if (on < off) return now >= on && now < off;
  return now >= on || now < off;
}

function selectRelease(releases, { channel = "stable" } = {}) {
  const list = (Array.isArray(releases) ? releases : []).filter((item) => item && !item.draft && item.tag_name);
  if (channel === "preview") return list[0] || null;
  return list.find((item) => !item.prerelease) || null;
}

function planApply({ stagingOk = false, inQuiet = false, force = false } = {}) {
  if (!stagingOk) return "keep";
  if (force || inQuiet) return "swap";
  return "wait";
}

function planRollback(healthOk) {
  return healthOk ? "keep" : "rollback";
}

async function readPointer(file) {
  try {
    return (await fsp.readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

async function writePointer(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, `${value}\n`, "utf8");
  await fsp.rename(tmp, file);
}

async function swapInstall({ installRoot, nextVersion }) {
  const versions = path.join(installRoot, "versions", nextVersion);
  await fsp.access(versions);
  const currentFile = path.join(installRoot, "current.txt");
  const previousFile = path.join(installRoot, "previous.txt");
  const current = await readPointer(currentFile);
  if (current && current !== nextVersion) await writePointer(previousFile, current);
  await writePointer(currentFile, nextVersion);
  return { current: nextVersion, previous: current && current !== nextVersion ? current : await readPointer(previousFile) };
}

async function rollbackInstall(installRoot) {
  const currentFile = path.join(installRoot, "current.txt");
  const previousFile = path.join(installRoot, "previous.txt");
  const previous = await readPointer(previousFile);
  if (!previous) throw Object.assign(new Error("No previous version to roll back to"), { status: 409 });
  const failed = await readPointer(currentFile);
  await writePointer(currentFile, previous);
  await writePointer(previousFile, failed);
  return { current: previous, failed };
}

module.exports = {
  inQuietWindow,
  selectRelease,
  planApply,
  planRollback,
  swapInstall,
  rollbackInstall,
  readPointer,
};
