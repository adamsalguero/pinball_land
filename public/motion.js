const CYCLE_MS = 28000;

function wallPhase(now, cycleMs = CYCLE_MS) {
  const value = Number(now) || 0;
  const span = Math.max(1000, Number(cycleMs) || CYCLE_MS);
  const t = ((value % span) + span) % span;
  return t / span;
}

function syncedNow(serverNow, receivedAt, localNow) {
  const skew = (Number(receivedAt) || 0) - (Number(serverNow) || 0);
  return (Number(localNow) || 0) - skew;
}

function particlesForSlot({ now, mode, theme, slotIndex = 0, screenCount = 1 }) {
  if (mode === "off") return [];
  const count = mode === "full" ? 42 : 16;
  const screens = Math.max(1, Number(screenCount) || 1);
  const slot = Math.max(0, Number(slotIndex) || 0);
  const kind = theme === "halloween" ? "bats" : theme === "christmas" ? "snow" : "dust";
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const drift = kind === "snow" ? 0.03 + (i % 5) * 0.012 : kind === "bats" ? 0.05 + (i % 4) * 0.02 : 0.008;
    const base = ((i * 97 + 13) % 1000) / 1000;
    const travel = ((base + ((Number(now) || 0) / 1000) * drift) % screens);
    const local = travel - slot;
    if (local < -0.08 || local > 1.08) continue;
    const y = ((i * 53) % 1000) / 1000;
    out.push({
      kind,
      x: local,
      y: kind === "snow" ? (y + ((Number(now) || 0) / 8000) * (0.4 + (i % 3) * 0.2)) % 1 : y,
      size: kind === "dust" ? 2 + (i % 3) : 8 + (i % 5) * 2,
      tilt: ((i * 17) % 40) - 20,
    });
  }
  return out;
}

function pinPositions(photoCount, screenCount) {
  const screens = Math.max(1, Number(screenCount) || 1);
  const cols = Math.max(3, screens * 3);
  const positions = [];
  for (let i = 0; i < photoCount; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push({
      x: ((col + 0.5) / cols) * 100,
      y: 14 + (row % 5) * 18 + ((i * 5) % 6),
      tilt: ((i * 37) % 13) - 6,
      delay: (i % 7) * 0.4,
    });
  }
  return positions;
}

const motionApi = { CYCLE_MS, wallPhase, syncedNow, particlesForSlot, pinPositions };
if (typeof module !== "undefined" && module.exports) module.exports = motionApi;
if (typeof window !== "undefined") window.PinballMotion = motionApi;
