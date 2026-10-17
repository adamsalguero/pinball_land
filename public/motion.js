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

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrap(value) {
  return ((value % 1) + 1) % 1;
}

function makeParticle(rng, kind) {
  const drift = kind === "snow" ? 0.015 + rng() * 0.03 : kind === "spider" ? 0.08 + rng() * 0.06 : 0.01 + rng() * 0.025;
  const x = rng();
  return {
    kind,
    x,
    y: kind === "spider" ? rng() * 0.22 : rng(),
    anchorX: x,
    vx: (rng() - 0.5) * (kind === "bat" ? 0.07 : 0.02),
    vy: kind === "bat" ? (rng() - 0.5) * 0.01 : drift,
    size: kind === "mote" ? 1.5 + rng() * 1.5 : kind === "snow" ? 1.4 + rng() * 2.6 : 16 + rng() * 14,
    phase: rng() * Math.PI * 2,
    spin: (rng() - 0.5) * 0.6,
    hue: rng(),
  };
}

function createField(theme, seed = 1) {
  const rng = mulberry32((Number(seed) || 1) * 997 + (theme === "halloween" ? 3 : theme === "christmas" ? 7 : 1));
  const particles = [];
  if (theme === "halloween") {
    const kinds = ["pumpkin", "spider", "candy", "bat"];
    for (let i = 0; i < 24; i += 1) particles.push(makeParticle(rng, kinds[i % kinds.length]));
  } else if (theme === "christmas") {
    for (let i = 0; i < 42; i += 1) particles.push(makeParticle(rng, i % 8 === 0 ? "ornament" : "snow"));
  } else {
    for (let i = 0; i < 8; i += 1) particles.push(makeParticle(rng, "mote"));
  }
  return { theme, particles };
}

function stepField(field, dt) {
  const sec = Math.max(0, Math.min(0.05, Number(dt) || 0));
  if (!field || sec === 0) return;
  for (const particle of field.particles) {
    particle.phase += sec * (particle.kind === "bat" ? 1.4 : 0.7);
    if (particle.kind === "bat") {
      particle.x += particle.vx * sec;
      particle.y += Math.sin(particle.phase) * 0.015 * sec * 8;
    } else if (particle.kind === "spider") {
      particle.phase += sec * particle.vy;
      const drop = (Math.sin(particle.phase) + 1) / 2;
      particle.y = 0.03 + drop * 0.28;
      particle.x = wrap((particle.anchorX ?? particle.x) + Math.sin(particle.phase * 0.65) * 0.025);
    } else if (particle.kind === "mote") {
      particle.x += particle.vx * sec * 0.35;
      particle.y += particle.vy * sec * 0.25;
    } else {
      particle.x += particle.vx * sec;
      particle.y += particle.vy * sec;
      if (particle.kind === "candy" || particle.kind === "ornament") particle.spin += sec * 0.15;
    }
    if (particle.kind === "spider") {
      particle.y = Math.min(0.33, Math.max(0.02, particle.y));
    } else {
      particle.x = wrap(particle.x);
      particle.y = wrap(particle.y);
    }
  }
}

function drawPumpkin(ctx, size) {
  const lobes = [-0.22, 0, 0.22];
  for (const offset of lobes) {
    ctx.fillStyle = offset === 0 ? "#ef7a22" : "#e15f12";
    ctx.beginPath();
    ctx.ellipse(offset * size, size * 0.06, size * 0.26, size * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "#b8430c";
  ctx.lineWidth = Math.max(1, size * 0.045);
  for (const offset of [-0.12, 0.12]) {
    ctx.beginPath();
    ctx.moveTo(offset * size, -size * 0.2);
    ctx.quadraticCurveTo(offset * size, size * 0.08, offset * size, size * 0.36);
    ctx.stroke();
  }
  ctx.strokeStyle = "#2f6b32";
  ctx.lineWidth = Math.max(1.6, size * 0.11);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.26);
  ctx.quadraticCurveTo(size * 0.16, -size * 0.5, size * 0.22, -size * 0.36);
  ctx.stroke();
  ctx.fillStyle = "#2a1408";
  const eye = (x) => {
    ctx.beginPath();
    ctx.moveTo(x * size, -size * 0.04);
    ctx.lineTo((x + (x < 0 ? -0.1 : 0.1)) * size, size * 0.08);
    ctx.lineTo((x + (x < 0 ? 0.08 : -0.08)) * size, size * 0.08);
    ctx.closePath();
    ctx.fill();
  };
  eye(-0.14);
  eye(0.14);
  ctx.beginPath();
  ctx.moveTo(0, size * 0.08);
  ctx.lineTo(size * 0.05, size * 0.16);
  ctx.lineTo(-size * 0.05, size * 0.16);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-size * 0.16, size * 0.22);
  ctx.quadraticCurveTo(0, size * 0.38, size * 0.16, size * 0.22);
  ctx.lineTo(size * 0.08, size * 0.26);
  ctx.quadraticCurveTo(0, size * 0.3, -size * 0.08, size * 0.26);
  ctx.closePath();
  ctx.fill();
}

function drawSpider(ctx, size, yNorm) {
  ctx.strokeStyle = "rgba(255,241,214,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -yNorm);
  ctx.lineTo(0, -size * 0.45);
  ctx.stroke();
  ctx.strokeStyle = "#1a120c";
  ctx.lineWidth = Math.max(1, size * 0.07);
  for (let i = 0; i < 4; i += 1) {
    const side = i < 2 ? -1 : 1;
    const lift = (i % 2 === 0 ? -0.35 : 0.2) * size;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(side * size * 0.35, lift, side * size * 0.62, lift * 0.2);
    ctx.stroke();
  }
  ctx.fillStyle = "#14110e";
  ctx.beginPath();
  ctx.ellipse(0, 0, size * 0.16, size * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, -size * 0.28, size * 0.1, 0, Math.PI * 2);
  ctx.fill();
}

function drawCandy(ctx, size) {
  const h = size * 0.86;
  const w = size * 0.5;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.5);
  ctx.quadraticCurveTo(w * 0.62, h * 0.05, w * 0.46, h * 0.42);
  ctx.quadraticCurveTo(0, h * 0.56, -w * 0.46, h * 0.42);
  ctx.quadraticCurveTo(-w * 0.62, h * 0.05, 0, -h * 0.5);
  ctx.closePath();
  ctx.fillStyle = "#f6c431";
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "#f7f3ea";
  ctx.fillRect(-size, -h * 0.52, size * 2, h * 0.28);
  ctx.fillStyle = "#f08a1a";
  ctx.fillRect(-size, -h * 0.24, size * 2, h * 0.3);
  ctx.restore();
}

function drawBat(ctx, size, flap) {
  ctx.fillStyle = "#1c140f";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-size * 0.15, -size * 0.35 * flap, -size * 0.7, -size * 0.05);
  ctx.quadraticCurveTo(-size * 0.35, size * 0.05, 0, size * 0.08);
  ctx.quadraticCurveTo(size * 0.35, size * 0.05, size * 0.7, -size * 0.05);
  ctx.quadraticCurveTo(size * 0.15, -size * 0.35 * flap, 0, 0);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, size * 0.02, size * 0.08, size * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawOrnament(ctx, size, hue) {
  const color = hue > 0.5 ? "#c8102e" : "#e8c872";
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, size * 0.08, size * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.ellipse(-size * 0.1, -size * 0.02, size * 0.08, size * 0.14, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#d4c4a8";
  ctx.fillRect(-size * 0.08, -size * 0.36, size * 0.16, size * 0.12);
}

function drawField(ctx, field, width, height) {
  ctx.clearRect(0, 0, width, height);
  if (!field) return;
  for (const particle of field.particles) {
    const x = particle.x * width;
    const y = particle.y * height;
    ctx.save();
    ctx.translate(x, y);
    if (particle.kind === "pumpkin") drawPumpkin(ctx, particle.size);
    else if (particle.kind === "spider") drawSpider(ctx, particle.size, y);
    else if (particle.kind === "candy") {
      ctx.rotate(Math.sin(particle.phase) * 0.25);
      drawCandy(ctx, particle.size);
    } else if (particle.kind === "bat") {
      drawBat(ctx, particle.size, 0.65 + Math.sin(particle.phase) * 0.35);
    } else if (particle.kind === "ornament") {
      ctx.rotate(Math.sin(particle.phase) * 0.15);
      drawOrnament(ctx, particle.size, particle.hue);
    } else if (particle.kind === "snow") {
      ctx.fillStyle = "rgba(244,239,228,0.82)";
      ctx.beginPath();
      ctx.arc(0, 0, particle.size, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(248,248,245,0.16)";
      ctx.beginPath();
      ctx.arc(0, 0, particle.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
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
      tilt: ((i * 37) % 7) - 3,
      delay: (i % 7) * 0.4,
    });
  }
  return positions;
}

const motionApi = {
  CYCLE_MS,
  wallPhase,
  syncedNow,
  createField,
  stepField,
  drawField,
  pinPositions,
};
if (typeof module !== "undefined" && module.exports) module.exports = motionApi;
if (typeof window !== "undefined") window.PinballMotion = motionApi;
