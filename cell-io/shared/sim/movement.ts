/**
 * Movement integration shared by the authoritative World and the client-side
 * predictor. Given the same body, stats, input, modifiers and hazards it
 * produces bit-for-bit the same result on both sides, which is what lets the
 * client replay unacknowledged inputs during reconciliation.
 */
import { APEX_LEVEL, } from '../progression';
import { DASH_IMPULSE, EVOLVE_SLOW, WORLD_SIZE } from '../constants';
import { angleDiff, clamp, TAU } from '../math';
import type { Hazard } from '../protocol';
import { thrustMultiplier, type CellStats } from '../stats';

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
}

export interface MoveInput {
  a: number;
  t: number;
}

export interface MoveMods {
  /** Poison slow fraction (0..1). */
  slow: number;
  /** In the evolution editor (moves at EVOLVE_SLOW). */
  evolving: boolean;
}

export const NO_MODS: MoveMods = { slow: 0, evolving: false };

export function sanitizeInput(input: MoveInput): MoveInput {
  return {
    a: Number.isFinite(input.a) ? input.a : 0,
    t: clamp(Number.isFinite(input.t) ? input.t : 0, 0, 1),
  };
}

/** Advance one body by dt seconds of steering, currents, wall clamping and turning. */
export function integrateMovement(b: Body, s: CellStats, raw: MoveInput, mods: MoveMods, hazards: readonly Hazard[], dt: number) {
  const { a, t } = sanitizeInput(raw);
  const local = angleDiff(b.heading, a);
  const facing = 0.7 + 0.3 * Math.max(0, Math.cos(local));
  let speedMult = thrustMultiplier(s, local) * facing;
  if (mods.slow > 0) speedMult *= 1 - mods.slow;
  if (mods.evolving) speedMult *= EVOLVE_SLOW;
  const target = s.baseSpeed * speedMult * t;
  let dvx = Math.cos(a) * target - b.vx;
  let dvy = Math.sin(a) * target - b.vy;
  const dv = Math.hypot(dvx, dvy);
  const maxDv = s.accel * dt;
  if (dv > maxDv) {
    dvx *= maxDv / dv;
    dvy *= maxDv / dv;
  }
  b.vx += dvx;
  b.vy += dvy;

  let px = 0;
  let py = 0;
  for (const h of hazards) {
    if (h.kind !== 'current') continue;
    const d = Math.hypot(b.x - h.x, b.y - h.y);
    const reach = h.r + s.radius * 0.5;
    if (d > reach) continue;
    const strength = (h.strength ?? 0) * (1 - d / reach) * Math.pow(22 / s.radius, 0.3);
    px += Math.cos(h.dir ?? 0) * strength;
    py += Math.sin(h.dir ?? 0) * strength;
  }

  const lo = s.radius * 0.5;
  const hi = WORLD_SIZE - s.radius * 0.5;
  b.x = clamp(b.x + (b.vx + px) * dt, lo, hi);
  b.y = clamp(b.y + (b.vy + py) * dt, lo, hi);
  if (b.x <= lo || b.x >= hi) b.vx *= -0.3;
  if (b.y <= lo || b.y >= hi) b.vy *= -0.3;

  if (t > 0.05) {
    const maxTurn = s.turnRate * dt;
    b.heading += clamp(angleDiff(b.heading, a), -maxTurn, maxTurn);
    if (b.heading > Math.PI) b.heading -= TAU;
    else if (b.heading < -Math.PI) b.heading += TAU;
  }
}

/**
 * Net propulsion vector in the cell's local frame: the directional part of
 * every cilia/flagellum thrust component. A rear flagellum points forward, a
 * side flagellum points sideways, an even ring of cilia cancels out.
 */
export function propulsionVector(s: CellStats): { x: number; y: number; mag: number } {
  let x = 0;
  let y = 0;
  for (const t of s.thrust) {
    const w = t.amount * (1 - t.isotropic);
    x += Math.cos(t.dir) * w;
    y += Math.sin(t.dir) * w;
  }
  return { x, y, mag: Math.hypot(x, y) };
}

/** Below this much net propulsion the dash follows your steering instead. */
export const DASH_PROPULSION_MIN = 0.1;

/**
 * Dash impulse vector. With a meaningful propulsion layout the dash fires
 * along it (relative to your heading), and stronger propulsion dashes harder;
 * without one it follows the steering direction. Validation (energy,
 * cooldown) happens in World.
 */
export function dashImpulse(b: Body, s: CellStats, input: MoveInput, level: number): { x: number; y: number } {
  const { a, t } = sanitizeInput(input);
  const p = propulsionVector(s);
  let dir: number;
  let boost = 1;
  if (p.mag >= DASH_PROPULSION_MIN) {
    dir = b.heading + Math.atan2(p.y, p.x);
    boost = 1 + 0.5 * Math.min(1, p.mag / 0.5);
  } else dir = t > 0.05 ? a : b.heading;
  const impulse = DASH_IMPULSE * boost * (level >= APEX_LEVEL ? 1.25 : 1) * s.weightMult * Math.pow(22 / s.radius, 0.2);
  return { x: Math.cos(dir) * impulse, y: Math.sin(dir) * impulse };
}
