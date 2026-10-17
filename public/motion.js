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
  const drift = kind === "snow" ? 0.015 + rng() * 0.03 : kind === "spider" ? 0.012 + rng() * 0.02 : 0.01 + rng() * 0.025;
  return {
    kind,
    x: rng(),
    y: rng(),
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
      particle.y += particle.vy * sec;
      particle.x += Math.sin(particle.phase) * 0.004;
    } else if (particle.kind === "mote") {
      particle.x += particle.vx * sec * 0.35;
      particle.y += particle.vy * sec * 0.25;
    } else {
      particle.x += particle.vx * sec;
      particle.y += particle.vy * sec;
      if (particle.kind === "candy" || particle.kind === "ornament") particle.spin += sec * 0.15;
    }
    if (particle.kind === "spider") {
      if (particle.y > 1.08) {
        particle.y = -0.08;
        particle.x = wrap(particle.x + 0.17);
      }
    } else {
      particle.x = wrap(particle.x);
      particle.y = wrap(particle.y);
    }
  }
}

function drawPumpkin(ctx, size) {
  ctx.fillStyle = "#e26a1a";
  ctx.beginPath();
  ctx.ellipse(0, 1, size * 0.46, size * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#9a3d08";
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.28);
  ctx.quadraticCurveTo(0, 0, 0, size * 0.36);
  ctx.stroke();
  ctx.strokeStyle = "#2f6b32";
  ctx.lineWidth = Math.max(1.25, size * 0.1);
  ctx.beginPath();
  ctx.moveTo(0, -size * 0.28);
  ctx.quadraticCurveTo(size * 0.16, -size * 0.48, size * 0.22, -size * 0.34);
  ctx.stroke();
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
  const h = size * 0.72;
  const w = size * 0.42;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.5);
  ctx.lineTo(w * 0.55, h * 0.15);
  ctx.lineTo(-w * 0.55, h * 0.15);
  ctx.closePath();
  ctx.fillStyle = "#f4f0e6";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-w * 0.55, h * 0.15);
  ctx.lineTo(w * 0.55, h * 0.15);
  ctx.lineTo(w * 0.38, h * 0.42);
  ctx.lineTo(-w * 0.38, h * 0.42);
  ctx.closePath();
  ctx.fillStyle = "#f0a202";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-w * 0.38, h * 0.42);
  ctx.lineTo(w * 0.38, h * 0.42);
  ctx.lineTo(0, h * 0.62);
  ctx.closePath();
  ctx.fillStyle = "#e23d28";
  ctx.fill();
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
