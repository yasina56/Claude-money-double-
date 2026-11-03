/**
 * Procedural cell and organelle art. Everything draws through a tiny Painter
 * interface so the same code renders cells in Phaser (game view) and in a
 * plain 2D canvas (evolution editor and organelle icons).
 */
import { ORGANELLES, TUNING, type Organelle, type OrganelleType } from '../../shared/organelles';
import { INTERNAL_SLOTS, organelleAngle, organelleDirection } from '../../shared/placement';
import { angleDiff, TAU } from '../../shared/math';
import { CellFlag } from '../../shared/protocol';

export interface Pt {
  x: number;
  y: number;
}

export interface Painter {
  fill(color: number, alpha: number): void;
  stroke(width: number, color: number, alpha: number): void;
  circle(x: number, y: number, r: number, fill: boolean): void;
  poly(pts: Pt[], fill: boolean, closed?: boolean): void;
}

export class CanvasPainter implements Painter {
  constructor(public ctx: CanvasRenderingContext2D) {}
  fill(color: number, alpha: number) {
    this.ctx.fillStyle = rgba(color, alpha);
  }
  stroke(width: number, color: number, alpha: number) {
    this.ctx.lineWidth = width;
    this.ctx.strokeStyle = rgba(color, alpha);
    this.ctx.lineJoin = 'round';
    this.ctx.lineCap = 'round';
  }
  circle(x: number, y: number, r: number, fill: boolean) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, Math.max(0, r), 0, TAU);
    fill ? this.ctx.fill() : this.ctx.stroke();
  }
  poly(pts: Pt[], fill: boolean, closed = true) {
    if (pts.length < 2) return;
    this.ctx.beginPath();
    this.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i].x, pts[i].y);
    if (closed) this.ctx.closePath();
    fill ? this.ctx.fill() : this.ctx.stroke();
  }
}

export function rgba(color: number, alpha: number) {
  return `rgba(${(color >> 16) & 255},${(color >> 8) & 255},${color & 255},${alpha})`;
}

export function hsl(h: number, s: number, l: number): number {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

export interface CellVisual {
  x: number;
  y: number;
  radius: number;
  heading: number;
  hue: number;
  organelles: Organelle[];
  flags: number;
  vx: number;
  vy: number;
  seed: number;
  jiggle: number; // 0..1 impact wobble
  /** Optional: highlight an organelle index (editor ghost). */
  ghostIndex?: number;
  ghostValid?: boolean;
}

interface Ctx {
  p: Painter;
  v: CellVisual;
  t: number;
  R: number;
  cos: number;
  sin: number;
  sx: number;
  sy: number;
}

/** Membrane radius (in units of R) at local angle th, including organic wobble. */
function membraneR(c: Ctx, th: number) {
  const { t, v } = c;
  return (
    1 +
    0.032 * Math.sin(3 * th + t * 2.1 + v.seed) +
    0.022 * Math.sin(5 * th - t * 1.7 + v.seed * 2) +
    v.jiggle * 0.07 * Math.sin(7 * th + t * 22)
  );
}

/** Local (radius units, heading-aligned) to world. Applies velocity squash. */
function T(c: Ctx, lx: number, ly: number): Pt {
  const x = lx * c.sx * c.R;
  const y = ly * c.sy * c.R;
  return { x: c.v.x + x * c.cos - y * c.sin, y: c.v.y + x * c.sin + y * c.cos };
}

const polar = (a: number, r: number) => ({ x: Math.cos(a) * r, y: Math.sin(a) * r });

export function drawCell(p: Painter, v: CellVisual, t: number, detail = 36) {
  const speed = Math.hypot(v.vx, v.vy);
  const stretch = Math.min(0.1, speed / 2600);
  const c: Ctx = { p, v, t, R: v.radius, cos: Math.cos(v.heading), sin: Math.sin(v.heading), sx: 1 + stretch, sy: 1 - stretch * 0.6 };
  const hue = v.hue;
  const body = hsl(hue, 70, 55);
  const rim = hsl(hue, 85, 74);
  const inner = hsl(hue, 70, 70);

  // Soft glow
  p.fill(rim, 0.07);
  p.circle(v.x, v.y, v.radius * 1.22, true);

  // Back-layer appendages
  v.organelles.forEach((o, i) => {
    if (o.type === 'flagellum') drawFlagellum(c, o, ghostAlpha(v, i));
    if (o.type === 'cilia') drawCilia(c, o, ghostAlpha(v, i));
  });

  // Body
  const outline: Pt[] = [];
  const cyto: Pt[] = [];
  for (let i = 0; i < detail; i++) {
    const th = (i / detail) * TAU;
    const m = membraneR(c, th);
    outline.push(T(c, Math.cos(th) * m, Math.sin(th) * m));
    cyto.push(T(c, Math.cos(th) * m * 0.8, Math.sin(th) * m * 0.8));
  }
  p.fill(body, 0.4);
  p.poly(outline, true);
  p.fill(inner, 0.2);
  p.poly(cyto, true);

  // Cytoplasm specks
  p.fill(0xffffff, 0.22);
  for (let k = 0; k < 6; k++) {
    const a = v.seed * 3 + k * 1.7 + t * 0.15 * (k % 2 ? 1 : -1);
    const r = 0.25 + ((k * 37) % 50) / 100;
    const q = T(c, Math.cos(a) * r, Math.sin(a) * r);
    p.circle(q.x, q.y, Math.max(1, v.radius * 0.035), true);
  }

  // Internal organelles
  const centerTaken = v.organelles.some((o) => ORGANELLES[o.type].mount === 'internal' && o.slot === 0);
  if (!centerTaken) drawNucleus(c, hue);
  drawVenomDucts(c);
  v.organelles.forEach((o, i) => {
    if (ORGANELLES[o.type].mount === 'internal') drawInternal(c, o, ghostAlpha(v, i), i === v.ghostIndex && v.ghostValid === false);
  });

  // Membrane rim
  p.stroke(Math.max(1.5, v.radius * 0.07), rim, 0.95);
  p.poly(outline, false);

  // Front-layer surface organelles
  v.organelles.forEach((o, i) => {
    const a = ghostAlpha(v, i);
    if (o.type === 'membrane') drawArmor(c, o, a);
  });
  v.organelles.forEach((o, i) => {
    const a = ghostAlpha(v, i);
    if (o.type === 'spikes') drawSpike(c, o, a);
    if (o.type === 'stinger') drawStinger(c, o, a);
  });

  // Status effects
  if (v.flags & CellFlag.Poisoned) {
    p.fill(0x9dff3d, 0.12);
    p.poly(outline, true);
    p.fill(0xb6ff5a, 0.7);
    for (let k = 0; k < 5; k++) {
      const ph = (t * 0.8 + k / 5) % 1;
      const a = v.seed + k * 1.3;
      const q = T(c, Math.cos(a) * 0.6, Math.sin(a) * 0.6 - ph * 0.9);
      p.circle(q.x, q.y - ph * v.radius * 0.4, v.radius * 0.06 * (1 - ph) + 1, true);
    }
  }
  if (v.flags & CellFlag.Bleeding) {
    p.fill(0xff3b5c, 0.6);
    for (let k = 0; k < 3; k++) {
      const a = v.seed * 2 + k * 2.1 + t;
      const q = T(c, Math.cos(a) * 0.95, Math.sin(a) * 0.95);
      p.circle(q.x, q.y, v.radius * 0.05 + 1, true);
    }
  }
  if (v.flags & CellFlag.Regenerating) {
    p.fill(0x8dffb5, 0.55);
    for (let k = 0; k < 4; k++) {
      const ph = (t * 0.6 + k / 4) % 1;
      const a = k * 1.57 + v.seed;
      const q = T(c, Math.cos(a) * (0.3 + ph * 0.8), Math.sin(a) * (0.3 + ph * 0.8));
      p.circle(q.x, q.y, (1 - ph) * v.radius * 0.05 + 0.8, true);
    }
  }
  if (v.flags & CellFlag.SpawnProtected) {
    p.stroke(2, 0xffffff, 0.35 + 0.25 * Math.sin(t * 8));
    p.circle(v.x, v.y, v.radius * 1.3, false);
  }
  if (v.flags & CellFlag.Evolving) {
    p.stroke(2.5, 0xffe27a, 0.8);
    const n = 12;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * TAU + t * 1.5;
      const pts: Pt[] = [];
      for (let s = 0; s <= 4; s++) pts.push({ x: v.x + Math.cos(a0 + s * 0.06) * v.radius * 1.35, y: v.y + Math.sin(a0 + s * 0.06) * v.radius * 1.35 });
      p.poly(pts, false, false);
    }
  }
}

const ghostAlpha = (v: CellVisual, i: number) => (i === v.ghostIndex ? 0.55 + 0.25 * Math.sin(performance.now() / 120) : 1);

function surfaceBase(c: Ctx, at: number, rOff = 0): Pt {
  const m = membraneR(c, at) + rOff;
  return polar(at, m);
}

function drawNucleus(c: Ctx, hue: number) {
  const pulse = 1 + 0.06 * Math.sin(c.t * 2.4 + c.v.seed);
  const q = T(c, -0.12, 0.04);
  c.p.fill(hsl(hue + 30, 55, 38), 0.75);
  c.p.circle(q.x, q.y, c.R * 0.27 * pulse, true);
  c.p.fill(hsl(hue + 30, 60, 60), 0.6);
  c.p.circle(q.x - c.R * 0.06, q.y - c.R * 0.05, c.R * 0.1 * pulse, true);
}

function drawSpike(c: Ctx, o: Organelle, alpha: number) {
  const at = organelleAngle(o);
  const dir = organelleDirection(o);
  const L = TUNING.spikeLength[o.level - 1] ?? 0.35;
  const w = 0.12 + 0.02 * o.level;
  const b1 = surfaceBase(c, at - w, -0.04);
  const b2 = surfaceBase(c, at + w, -0.04);
  const base = surfaceBase(c, at);
  const tip = { x: base.x + Math.cos(dir) * L, y: base.y + Math.sin(dir) * L };
  const pts = [T(c, b1.x, b1.y), T(c, tip.x, tip.y), T(c, b2.x, b2.y)];
  c.p.fill(o.level >= 2 ? 0xffe6c2 : 0xfff6e6, alpha);
  c.p.poly(pts, true);
  c.p.stroke(Math.max(1, c.R * 0.03), o.level >= 3 ? 0x7a2a1a : 0x6b5a48, 0.9 * alpha);
  c.p.poly(pts, false);
  if (o.level >= 3) {
    // Barbs
    for (const side of [-1, 1]) {
      const mid = { x: base.x + Math.cos(dir) * L * 0.55, y: base.y + Math.sin(dir) * L * 0.55 };
      const n = { x: -Math.sin(dir) * side, y: Math.cos(dir) * side };
      const bp = [
        T(c, mid.x + n.x * 0.04, mid.y + n.y * 0.04),
        T(c, mid.x + n.x * 0.14 - Math.cos(dir) * 0.08, mid.y + n.y * 0.14 - Math.sin(dir) * 0.08),
        T(c, mid.x + Math.cos(dir) * 0.08, mid.y + Math.sin(dir) * 0.08),
      ];
      c.p.fill(0xffd2a8, alpha);
      c.p.poly(bp, true);
    }
  }
}

function venomLinked(organelles: Organelle[], o: Organelle): boolean {
  const dir = organelleDirection(o);
  return organelles.some(
    (s) => s.type === 'venom' && (s.slot === 0 || Math.abs(angleDiff(organelleAngle(s), dir)) <= TUNING.venomLinkArc),
  );
}

function drawStinger(c: Ctx, o: Organelle, alpha: number) {
  const at = organelleAngle(o);
  const dir = organelleDirection(o);
  const L = 0.5 + 0.06 * o.level;
  const base = surfaceBase(c, at);
  const b1 = surfaceBase(c, at - 0.06, -0.03);
  const b2 = surfaceBase(c, at + 0.06, -0.03);
  const tip = { x: base.x + Math.cos(dir) * L, y: base.y + Math.sin(dir) * L };
  const linked = venomLinked(c.v.organelles, o);
  const pts = [T(c, b1.x, b1.y), T(c, tip.x, tip.y), T(c, b2.x, b2.y)];
  c.p.fill(0xe9d7ff, alpha);
  c.p.poly(pts, true);
  c.p.stroke(Math.max(1, c.R * 0.025), 0x5b2a7a, alpha);
  c.p.poly(pts, false);
  const tp = T(c, tip.x, tip.y);
  c.p.fill(linked ? 0xc04dff : 0x8a7a99, alpha * (linked ? 0.7 + 0.3 * Math.sin(c.t * 6) : 0.8));
  c.p.circle(tp.x, tp.y, Math.max(1.5, c.R * 0.05), true);
}

function drawArmor(c: Ctx, o: Organelle, alpha: number) {
  const at = organelleAngle(o);
  const half = TUNING.membraneHalfArc;
  const n = 10;
  const outer: Pt[] = [];
  const innerPts: Pt[] = [];
  const thick = 0.1 + 0.035 * o.level;
  for (let k = 0; k <= n; k++) {
    const th = at - half + (2 * half * k) / n;
    const m = membraneR(c, th);
    outer.push(T(c, Math.cos(th) * (m + thick), Math.sin(th) * (m + thick)));
    innerPts.push(T(c, Math.cos(th) * (m - 0.02), Math.sin(th) * (m - 0.02)));
  }
  const color = o.level >= 3 ? 0x3e5a7a : o.level === 2 ? 0x5f86b8 : 0x86a9d8;
  c.p.fill(color, 0.9 * alpha);
  c.p.poly([...outer, ...innerPts.reverse()], true);
  c.p.stroke(Math.max(1, c.R * 0.025), 0xd8ecff, 0.7 * alpha);
  c.p.poly(outer, false, false);
  // Plate seams
  c.p.stroke(Math.max(1, c.R * 0.02), 0x1d2c40, 0.6 * alpha);
  for (let k = 1; k < 4; k++) {
    const th = at - half + (2 * half * k) / 4;
    const m = membraneR(c, th);
    c.p.poly([T(c, Math.cos(th) * m, Math.sin(th) * m), T(c, Math.cos(th) * (m + thick), Math.sin(th) * (m + thick))], false, false);
  }
}

function drawCilia(c: Ctx, o: Organelle, alpha: number) {
  const at = organelleAngle(o);
  const dir = organelleDirection(o);
  const tilt = dir - at;
  const count = 5 + o.level;
  const len = 0.2 + 0.05 * o.level;
  c.p.stroke(Math.max(1, c.R * 0.03), 0xc9fbff, 0.85 * alpha);
  for (let k = 0; k < count; k++) {
    const th = at + (k / (count - 1) - 0.5) * 0.5;
    const m = membraneR(c, th);
    const beat = Math.sin(c.t * 14 + k * 0.9 + c.v.seed) * 0.35;
    const base = polar(th, m * 0.97);
    const a1 = th + tilt + beat * 0.5;
    const mid = { x: base.x + Math.cos(a1) * len * 0.5, y: base.y + Math.sin(a1) * len * 0.5 };
    const a2 = a1 + beat;
    const tip = { x: mid.x + Math.cos(a2) * len * 0.5, y: mid.y + Math.sin(a2) * len * 0.5 };
    c.p.poly([T(c, base.x, base.y), T(c, mid.x, mid.y), T(c, tip.x, tip.y)], false, false);
  }
}

function drawFlagellum(c: Ctx, o: Organelle, alpha: number) {
  const at = organelleAngle(o);
  const dir = organelleDirection(o);
  const L = 1.5 + 0.2 * o.level;
  const base = surfaceBase(c, at, -0.05);
  const segs = 16;
  const pts: Pt[] = [];
  const speed = Math.hypot(c.v.vx, c.v.vy);
  const freq = 8 + Math.min(14, speed / 20);
  const nx = -Math.sin(dir);
  const ny = Math.cos(dir);
  for (let k = 0; k <= segs; k++) {
    const f = k / segs;
    const along = f * L;
    const lat = Math.sin(f * 7 - c.t * freq) * 0.16 * f;
    pts.push(T(c, base.x + Math.cos(dir) * along + nx * lat, base.y + Math.sin(dir) * along + ny * lat));
  }
  c.p.stroke(Math.max(2, c.R * 0.11), 0xb39b2e, 0.9 * alpha);
  c.p.poly(pts.slice(0, 9), false, false);
  c.p.stroke(Math.max(1.5, c.R * 0.07), 0xffe066, 0.95 * alpha);
  c.p.poly(pts, false, false);
}

function internalPos(o: Organelle): Pt {
  const s = INTERNAL_SLOTS[o.slot];
  return polar(s.a, s.r * 0.95);
}

function drawVenomDucts(c: Ctx) {
  const sacs = c.v.organelles.filter((o) => o.type === 'venom');
  if (!sacs.length) return;
  c.p.stroke(Math.max(1, c.R * 0.025), 0xc04dff, 0.45);
  for (const d of c.v.organelles) {
    if (d.type !== 'stinger' && d.type !== 'spikes') continue;
    const dir = organelleDirection(d);
    for (const s of sacs) {
      if (s.slot !== 0 && Math.abs(angleDiff(organelleAngle(s), dir)) > TUNING.venomLinkArc) continue;
      const a = internalPos(s);
      const b = surfaceBase(c, organelleAngle(d), -0.05);
      c.p.poly([T(c, a.x, a.y), T(c, (a.x + b.x) / 2 + 0.05, (a.y + b.y) / 2), T(c, b.x, b.y)], false, false);
    }
  }
}

function drawInternal(c: Ctx, o: Organelle, alpha: number, invalid: boolean) {
  const lp = internalPos(o);
  const q = T(c, lp.x, lp.y);
  const R = c.R;
  const pulse = 1 + 0.08 * Math.sin(c.t * 3 + o.slot);
  if (invalid) {
    c.p.stroke(2, 0xff4d6d, 0.9);
    c.p.circle(q.x, q.y, R * 0.22, false);
  }
  switch (o.type) {
    case 'mitochondria': {
      const rot = c.v.heading + INTERNAL_SLOTS[o.slot].a + 0.6;
      const pts: Pt[] = [];
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * TAU;
        const ex = Math.cos(a) * R * 0.2;
        const ey = Math.sin(a) * R * 0.11;
        pts.push({ x: q.x + ex * Math.cos(rot) - ey * Math.sin(rot), y: q.y + ex * Math.sin(rot) + ey * Math.cos(rot) });
      }
      c.p.fill(0xff9d4d, 0.9 * alpha);
      c.p.poly(pts, true);
      c.p.stroke(Math.max(1, R * 0.02), 0x8a3d0a, 0.9 * alpha);
      c.p.poly(pts, false);
      const zig: Pt[] = [];
      for (let k = 0; k <= 6; k++) {
        const ex = (k / 6 - 0.5) * R * 0.3;
        const ey = (k % 2 ? 1 : -1) * R * 0.05 * Math.sin(c.t * 4 + k);
        zig.push({ x: q.x + ex * Math.cos(rot) - ey * Math.sin(rot), y: q.y + ex * Math.sin(rot) + ey * Math.cos(rot) });
      }
      c.p.poly(zig, false, false);
      break;
    }
    case 'venom':
      c.p.fill(0xb04dff, 0.25 * alpha);
      c.p.circle(q.x, q.y, R * 0.24 * pulse, true);
      c.p.fill(0xb04dff, 0.85 * alpha);
      c.p.circle(q.x, q.y, R * (0.12 + 0.02 * o.level) * pulse, true);
      c.p.fill(0xf0c2ff, 0.8 * alpha);
      c.p.circle(q.x - R * 0.04, q.y - R * 0.04, R * 0.04, true);
      break;
    case 'regen':
      c.p.fill(0x5dff9a, 0.25 * alpha);
      c.p.circle(q.x, q.y, R * 0.25 * pulse * pulse, true);
      c.p.fill(0x2fd479, 0.9 * alpha);
      c.p.circle(q.x, q.y, R * 0.16 * pulse, true);
      c.p.stroke(Math.max(1.5, R * 0.04), 0xe8fff0, 0.9 * alpha);
      c.p.poly([{ x: q.x - R * 0.07, y: q.y }, { x: q.x + R * 0.07, y: q.y }], false, false);
      c.p.poly([{ x: q.x, y: q.y - R * 0.07 }, { x: q.x, y: q.y + R * 0.07 }], false, false);
      break;
    case 'toxin': {
      c.p.fill(0xc6ff3d, 0.3 * alpha);
      c.p.circle(q.x, q.y, R * 0.22 * pulse, true);
      c.p.fill(0x9ed61e, 0.9 * alpha);
      c.p.circle(q.x, q.y, R * 0.14, true);
      c.p.fill(0xf4ffc0, 0.85 * alpha);
      for (let k = 0; k < 3; k++) {
        const ph = (c.t * 0.7 + k / 3) % 1;
        c.p.circle(q.x + Math.cos(k * 2.1) * R * 0.07, q.y + Math.sin(k * 2.1) * R * 0.07 - ph * R * 0.08, R * 0.03 * (1 - ph) + 0.5, true);
      }
      break;
    }
  }
}

/** Icon for an organelle type: a mini cell showing it in a typical spot. */
export function drawOrganelleIcon(ctx: CanvasRenderingContext2D, type: OrganelleType, level: number, size: number, t: number, hue = 190) {
  const def = ORGANELLES[type];
  const slot = def.mount === 'internal' ? 0 : type === 'flagellum' || type === 'cilia' ? 8 : 0;
  ctx.clearRect(0, 0, size, size);
  const R = type === 'flagellum' ? size * 0.22 : size * 0.3;
  const cx = type === 'flagellum' ? size * 0.68 : type === 'cilia' ? size * 0.56 : type === 'spikes' || type === 'stinger' ? size * 0.4 : size / 2;
  drawCell(new CanvasPainter(ctx), { x: cx, y: size / 2, radius: R, heading: 0, hue, organelles: [{ type, level, slot, tilt: 0 }], flags: 0, vx: 0, vy: 0, seed: 1, jiggle: 0 }, t, 28);
}
