// Venue holidays follow Pacific time. Halloween owns October and Halloween
// night. Christmas owns December through the 26th. The ranges do not overlap.
const VENUE_TIME_ZONE = "America/Los_Angeles";

function venueDateParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: VENUE_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(now));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function seasonsOn(now = Date.now()) {
  const { month, day } = venueDateParts(now);
  const seasons = [];
  if (month === 10 || (month === 11 && day === 1)) seasons.push("halloween");
  if (month === 12 && day >= 1 && day <= 26) seasons.push("christmas");
  return seasons;
}

function starterThemes(theme, now = Date.now()) {
  const forced = String(process.env.PINBALL_STARTER_THEMES || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item === "halloween" || item === "christmas");
  if (forced.length) return [...new Set(forced)];
  // The regular theme never plays a clip. An explicit holiday replaces the
  // calendar, so Christmas in October is Christmas only.
  if (theme === "halloween" || theme === "christmas") return [theme];
  return [];
}

module.exports = {
  VENUE_TIME_ZONE,
  venueDateParts,
  seasonsOn,
  starterThemes,
};
