let filter = null;
try {
  filter = require("leo-profanity");
} catch {
  filter = null;
}

function maskProfanity(value) {
  const text = String(value || "");
  if (!text || !filter) return text;
  return filter.clean(text);
}

module.exports = { maskProfanity };
