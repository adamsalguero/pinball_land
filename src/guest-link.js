const crypto = require("crypto");

const GUEST_COOKIE = "pl_guest";
const ROTATE_HOUR = 4;
const COOKIE_MS = 12 * 60 * 60 * 1000;

function guestDay(now = Date.now(), timeZone) {
  const shifted = new Date(Number(now) - ROTATE_HOUR * 60 * 60 * 1000);
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return format.format(shifted);
}

function previousDay(day) {
  const [year, month, date] = String(day || "").split("-").map(Number);
  const stamp = new Date(Date.UTC(year, (month || 1) - 1, date || 1));
  stamp.setUTCDate(stamp.getUTCDate() - 1);
  return stamp.toISOString().slice(0, 10);
}

function guestToken(secret, day) {
  return crypto.createHmac("sha256", String(secret || "")).update(`guest:${day}`).digest("base64url");
}

function tokensFor(secret, now = Date.now(), timeZone) {
  const today = guestDay(now, timeZone);
  const yesterday = previousDay(today);
  return {
    today,
    yesterday,
    tokens: [guestToken(secret, today), guestToken(secret, yesterday)],
  };
}

function tokenMatches(secret, token, now = Date.now(), timeZone) {
  const given = String(token || "");
  if (!given) return false;
  return tokensFor(secret, now, timeZone).tokens.some((expected) => {
    const left = Buffer.from(given);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
}

function signGuestCookie(secret, exp) {
  const payload = Buffer.from(JSON.stringify({ exp: Number(exp) })).toString("base64url");
  const sig = crypto.createHmac("sha256", String(secret || "")).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function readGuestCookie(secret, raw, now = Date.now()) {
  const text = String(raw || "");
  const dot = text.indexOf(".");
  if (dot <= 0) return null;
  const payload = text.slice(0, dot);
  const sig = text.slice(dot + 1);
  const expected = crypto.createHmac("sha256", String(secret || "")).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || !(Number(data.exp) > Number(now))) return null;
    return data;
  } catch {
    return null;
  }
}

function scanPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pinball Land</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1a1916; color: #f8f8f5; font-family: "Segoe UI", sans-serif; }
    main { max-width: 28rem; padding: 2rem; text-align: center; }
    h1 { font-size: 1.8rem; margin-bottom: 0.6rem; }
    p { font-size: 1.15rem; line-height: 1.45; color: #e5e2da; }
  </style>
</head>
<body>
  <main>
    <p>Pinball Land</p>
    <h1>Scan the QR code at Pinball Land</h1>
    <p>The photo link on the wall changes every day. Open the code on the pinboard, then you can post from this phone for the rest of your visit.</p>
  </main>
</body>
</html>`;
}

module.exports = {
  GUEST_COOKIE,
  ROTATE_HOUR,
  COOKIE_MS,
  guestDay,
  previousDay,
  guestToken,
  tokensFor,
  tokenMatches,
  signGuestCookie,
  readGuestCookie,
  scanPage,
};
