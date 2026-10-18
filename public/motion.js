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

const WORLD_W = 5760;
const WORLD_H = 1080;
const SLICE_W = 1920;

function wrapWorld(value, span) {
  const size = span || 1;
  return ((value % size) + size) % size;
}

function makeParticle(rng, kind) {
  const snow = kind === "snow";
  const bat = kind === "bat";
  const spider = kind === "spider";
  return {
    kind,
    originX: rng() * WORLD_W,
    originY: spider ? 40 + rng() * 80 : rng() * WORLD_H,
    vx: bat ? 70 + rng() * 90 : snow ? 8 + rng() * 18 : 18 + rng() * 36,
    vy: snow ? 28 + rng() * 40 : spider ? 0.35 + rng() * 0.25 : 12 + rng() * 28,
    size: kind === "mote" ? 2 + rng() * 2 : snow ? 2 + rng() * 4 : 28 + rng() * 22,
    phase: rng() * Math.PI * 2,
    spin: (rng() - 0.5) * 0.8,
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
  return { theme, seed: Number(seed) || 1, particles };
}

function worldPoint(particle, elapsed) {
  const t = Math.max(0, Number(elapsed) || 0);
  if (!particle) return { x: 0, y: 0, flap: 0 };
  if (particle.kind === "spider") {
    const drop = (Math.sin(t * particle.vy + particle.phase) + 1) / 2;
    return {
      x: wrapWorld(particle.originX + Math.sin(t * 0.7 + particle.phase) * 36, WORLD_W),
      y: 24 + drop * 320,
      flap: t * particle.vy + particle.phase,
    };
  }
  if (particle.kind === "bat") {
    return {
      x: wrapWorld(particle.originX + particle.vx * t, WORLD_W),
      y: wrapWorld(particle.originY + Math.sin(t * 1.3 + particle.phase) * 48, WORLD_H),
      flap: Math.sin(t * 9 + particle.phase),
    };
  }
  return {
    x: wrapWorld(particle.originX + particle.vx * t * (particle.kind === "mote" ? 0.35 : 1), WORLD_W),
    y: wrapWorld(particle.originY + particle.vy * t * (particle.kind === "mote" ? 0.25 : 1), WORLD_H),
    flap: Math.sin(t + particle.phase),
  };
}

function screenPoint(world, slot, viewWidth, viewHeight) {
  const slice = Math.max(0, Number(slot) || 0) * SLICE_W;
  const width = Math.max(1, Number(viewWidth) || SLICE_W);
  const height = Math.max(1, Number(viewHeight) || WORLD_H);
  const scaleX = width / SLICE_W;
  const scaleY = height / WORLD_H;
  let local = world.x - slice;
  if (local > WORLD_W / 2) local -= WORLD_W;
  if (local < -WORLD_W / 2) local += WORLD_W;
  return { x: local * scaleX, y: world.y * scaleY, scaleX, scaleY };
}

function stepField(field, dt) {
  const sec = Math.max(0, Math.min(0.05, Number(dt) || 0));
  if (!field || sec === 0) return;
  field.elapsed = (Number(field.elapsed) || 0) + sec;
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

function spiderSilk(point) {
  const x = Number(point?.x) || 0;
  const y = Number(point?.y) || 0;
  return { x1: x, y1: 0, x2: x, y2: y };
}

function strokeSpiderSilk(ctx, point, size) {
  const silk = spiderSilk(point);
  ctx.save();
  ctx.strokeStyle = "rgba(255, 236, 214, 0.8)";
  ctx.lineWidth = Math.max(1, (Number(size) || 28) * 0.02);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(silk.x1, silk.y1);
  ctx.lineTo(silk.x2, silk.y2);
  ctx.stroke();
  ctx.restore();
}

function drawSpider(ctx, size, phase) {
  const pose = Number(phase) || 0;
  const body = size * 0.22;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#141414";
  ctx.lineWidth = Math.max(1.35, size * 0.04);
  const reach = [0.30, 0.38, 0.36, 0.28];
  const lift = [0.22, 0.32, 0.30, 0.20];
  const drop = [0.26, 0.34, 0.36, 0.28];
  for (let i = 0; i < 8; i += 1) {
    const side = i < 4 ? -1 : 1;
    const index = i % 4;
    const spread = [-0.95, -0.32, 0.32, 0.95][index];
    const wiggle = Math.sin(pose * 2 + index * 0.8 + (side > 0 ? 0.6 : 0)) * size * 0.028;
    const hipX = side * body * 0.62;
    const hipY = spread * body * 0.38;
    const kneeX = side * size * reach[index];
    const kneeY = hipY - size * lift[index] + wiggle;
    const footX = kneeX + side * size * 0.035;
    const footY = hipY + size * drop[index] + wiggle * 0.25;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(footX, footY);
    ctx.stroke();
  }
  ctx.lineWidth = Math.max(1, size * 0.026);
  const fuzz = 26;
  for (let i = 0; i < fuzz; i += 1) {
    const angle = (i / fuzz) * Math.PI * 2;
    const len = body * (0.26 + (i % 4) * 0.08);
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * body * 0.8, Math.sin(angle) * body * 0.8);
    ctx.lineTo(Math.cos(angle) * (body + len), Math.sin(angle) * (body + len));
    ctx.stroke();
  }
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(0, 0, body, 0, Math.PI * 2);
  ctx.fill();
  const eye = size * 0.086;
  for (const side of [-1, 1]) {
    const ex = side * size * 0.07;
    const ey = -size * 0.012;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ex, ey, eye, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = Math.max(1, size * 0.012);
    ctx.stroke();
    ctx.fillStyle = "#161616";
    const look = Math.sin(pose * 0.5) * eye * 0.1;
    ctx.beginPath();
    ctx.arc(ex + look, ey + eye * 0.12, eye * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
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
  size = (Number(size) || 0) * 0.8;
  const wing = Math.max(-1, Math.min(1, Number(flap) || 0));
  const lift = 0.15 + (wing + 1) * 0.42;
  const membrane = (side) => {
    ctx.beginPath();
    ctx.moveTo(side * size * 0.12, -size * 0.02);
    ctx.quadraticCurveTo(side * size * 0.35, -size * lift, side * size * 0.95, -size * (0.08 + lift * 0.25));
    ctx.quadraticCurveTo(side * size * 0.72, size * 0.02, side * size * 0.78, size * 0.16);
    ctx.quadraticCurveTo(side * size * 0.48, size * 0.05, side * size * 0.55, size * 0.22);
    ctx.quadraticCurveTo(side * size * 0.28, size * 0.08, side * size * 0.16, size * 0.12);
    ctx.closePath();
    ctx.fillStyle = "#2a211c";
    ctx.fill();
    ctx.strokeStyle = "#140e0c";
    ctx.lineWidth = Math.max(1, size * 0.04);
    ctx.stroke();
  };
  membrane(-1);
  membrane(1);
  ctx.fillStyle = "#3a2c24";
  ctx.beginPath();
  ctx.ellipse(0, size * 0.02, size * 0.16, size * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#4a382c";
  ctx.beginPath();
  ctx.arc(0, -size * 0.2, size * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a120e";
  ctx.beginPath();
  ctx.moveTo(-size * 0.08, -size * 0.28);
  ctx.lineTo(-size * 0.02, -size * 0.16);
  ctx.lineTo(-size * 0.14, -size * 0.16);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(size * 0.08, -size * 0.28);
  ctx.lineTo(size * 0.14, -size * 0.16);
  ctx.lineTo(size * 0.02, -size * 0.16);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffe7a8";
  for (const eye of [-0.045, 0.045]) {
    ctx.beginPath();
    ctx.arc(eye * size, -size * 0.2, size * 0.028, 0, Math.PI * 2);
    ctx.fill();
  }
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

function silkHitsAvoid(x, y, avoid) {
  if (!Array.isArray(avoid) || !avoid.length) return false;
  const lineX = Number(x) || 0;
  const lineY = Number(y) || 0;
  for (const rect of avoid) {
    if (!rect) continue;
    const left = Number(rect.x) || 0;
    const top = Number(rect.y) || 0;
    const right = left + (Number(rect.w) || 0);
    const bottom = top + (Number(rect.h) || 0);
    if (lineX >= left && lineX <= right && lineY > top && bottom > 0) return true;
  }
  return false;
}

function overlapsAvoid(x, y, radius, avoid) {
  if (!Array.isArray(avoid) || !avoid.length) return false;
  const reach = Math.max(0, Number(radius) || 0);
  for (const rect of avoid) {
    if (!rect) continue;
    const left = Number(rect.x) || 0;
    const top = Number(rect.y) || 0;
    const right = left + (Number(rect.w) || 0);
    const bottom = top + (Number(rect.h) || 0);
    const nearestX = Math.max(left, Math.min(x, right));
    const nearestY = Math.max(top, Math.min(y, bottom));
    const dx = x - nearestX;
    const dy = y - nearestY;
    if (dx * dx + dy * dy <= reach * reach) return true;
  }
  return false;
}

function drawField(ctx, field, width, height, options = {}) {
  ctx.clearRect(0, 0, width, height);
  if (!field) return;
  const elapsed = Number.isFinite(Number(options.elapsed)) ? Number(options.elapsed) : Number(field.elapsed) || 0;
  const slot = Number.isFinite(Number(options.slot)) ? Number(options.slot) : 0;
  const margin = 80;
  for (const particle of field.particles) {
    const world = worldPoint(particle, elapsed);
    const point = screenPoint(world, slot, width, height);
    if (point.x < -margin || point.x > width + margin || point.y < -margin || point.y > height + margin) continue;
    if (overlapsAvoid(point.x, point.y, particle.size * 0.7, options.avoid)) continue;
    if (particle.kind === "spider" && !silkHitsAvoid(point.x, point.y, options.avoid)) strokeSpiderSilk(ctx, point, particle.size);
    ctx.save();
    ctx.translate(point.x, point.y);
    if (particle.kind === "pumpkin") drawPumpkin(ctx, particle.size);
    else if (particle.kind === "spider") drawSpider(ctx, particle.size, world.flap);
    else if (particle.kind === "candy") {
      ctx.rotate(Math.sin(elapsed + particle.phase) * 0.25);
      drawCandy(ctx, particle.size);
    } else if (particle.kind === "bat") {
      drawBat(ctx, particle.size, world.flap);
    } else if (particle.kind === "ornament") {
      ctx.rotate(Math.sin(elapsed * 0.4 + particle.phase) * 0.15);
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
  WORLD_W,
  WORLD_H,
  SLICE_W,
  wallPhase,
  syncedNow,
  createField,
  stepField,
  worldPoint,
  screenPoint,
  drawField,
  drawSpider,
  drawBat,
  spiderSilk,
  strokeSpiderSilk,
  pinPositions,
};
if (typeof module !== "undefined" && module.exports) module.exports = motionApi;
if (typeof window !== "undefined") window.PinballMotion = motionApi;
