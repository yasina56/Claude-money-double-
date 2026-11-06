/**
 * Normalized attachment coordinate system.
 *
 * Positions are stored relative to the cell, never in pixels:
 *  - Surface organelles sit on one of SURFACE_SLOTS snap angles around the
 *    membrane. Angle 0 is the cell's front (its heading); angles grow
 *    clockwise on screen (Phaser's y-down convention).
 *  - Internal organelles sit in one of INTERNAL_SLOTS, given as (r, angle)
 *    with r a fraction of the current cell radius.
 *
 * Because everything is normalized, organelles stay correctly attached as the
 * cell grows, shrinks or deforms.
 */
import { ORGANELLES, type Organelle, type OrganelleType } from './organelles';
import { TAU } from './math';

export const SURFACE_SLOTS = 16;
export const MAX_TILT = Math.PI / 4;
export const TILT_STEP = Math.PI / 12;

export const INTERNAL_SLOTS: ReadonlyArray<{ r: number; a: number }> = [
  { r: 0, a: 0 },
  ...Array.from({ length: 6 }, (_, k) => ({ r: 0.5, a: (k * TAU) / 6 })),
];

export function surfaceSlotAngle(slot: number): number {
  return (slot * TAU) / SURFACE_SLOTS;
}

/** Local angle (relative to heading) of an organelle's attachment point. */
export function organelleAngle(o: Pick<Organelle, 'type' | 'slot'>): number {
  return ORGANELLES[o.type].mount === 'surface' ? surfaceSlotAngle(o.slot) : INTERNAL_SLOTS[o.slot].a;
}

/** Local direction an organelle points (attachment angle plus tilt). */
export function organelleDirection(o: Organelle): number {
  return organelleAngle(o) + (ORGANELLES[o.type].mount === 'surface' ? o.tilt : 0);
}

/** Local position in units of cell radius. Surface organelles sit at r = 1. */
export function organelleLocalPos(o: Pick<Organelle, 'type' | 'slot'>): { x: number; y: number } {
  const def = ORGANELLES[o.type];
  if (def.mount === 'surface') {
    const a = surfaceSlotAngle(o.slot);
    return { x: Math.cos(a), y: Math.sin(a) };
  }
  const s = INTERNAL_SLOTS[o.slot];
  return { x: Math.cos(s.a) * s.r, y: Math.sin(s.a) * s.r };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

export function surfaceSnapsFor(slot: number, span: number): number[] {
  const half = Math.floor(span / 2);
  const out: number[] = [];
  for (let k = -half; k <= half; k++) out.push(mod(slot + k, SURFACE_SLOTS));
  return out;
}

export function occupiedSurface(organelles: Organelle[]): Set<number> {
  const set = new Set<number>();
  for (const o of organelles) {
    const def = ORGANELLES[o.type];
    if (def.mount === 'surface') for (const s of surfaceSnapsFor(o.slot, def.span)) set.add(s);
  }
  return set;
}

export function occupiedInternal(organelles: Organelle[]): Set<number> {
  const set = new Set<number>();
  for (const o of organelles) if (ORGANELLES[o.type].mount === 'internal') set.add(o.slot);
  return set;
}

export function capacityUsed(organelles: Organelle[]): number {
  return organelles.reduce((sum, o) => sum + ORGANELLES[o.type].slotCost, 0);
}

/** Organelle slot capacity granted by level (see progression notes in README). */
export function capacityForLevel(level: number): number {
  const table = [0, 0, 2, 3, 4, 4, 5, 6, 6, 7, 8];
  if (level < table.length) return table[level];
  return Math.min(13, 8 + Math.floor((level - 10) / 2));
}

export type PlacementError = 'mount' | 'range' | 'occupied' | 'tilt' | 'capacity';

export function checkPlacement(
  organelles: Organelle[],
  type: OrganelleType,
  slot: number,
  tilt: number,
  capacity: number,
): PlacementError | null {
  const def = ORGANELLES[type];
  if (!Number.isInteger(slot) || !Number.isFinite(tilt)) return 'range';
  if (capacityUsed(organelles) + def.slotCost > capacity) return 'capacity';
  if (def.mount === 'surface') {
    if (slot < 0 || slot >= SURFACE_SLOTS) return 'range';
    if (Math.abs(tilt) > MAX_TILT + 1e-6) return 'tilt';
    const occ = occupiedSurface(organelles);
    for (const s of surfaceSnapsFor(slot, def.span)) if (occ.has(s)) return 'occupied';
  } else {
    if (slot < 0 || slot >= INTERNAL_SLOTS.length) return 'range';
    if (tilt !== 0) return 'tilt';
    if (occupiedInternal(organelles).has(slot)) return 'occupied';
  }
  return null;
}

/** All slots where `type` could be placed right now (ignores capacity). */
export function validSlots(organelles: Organelle[], type: OrganelleType): number[] {
  const def = ORGANELLES[type];
  const n = def.mount === 'surface' ? SURFACE_SLOTS : INTERNAL_SLOTS.length;
  const out: number[] = [];
  for (let s = 0; s < n; s++) if (checkPlacement(organelles, type, s, 0, Infinity) === null) out.push(s);
  return out;
}

/** Valid slot whose attachment angle is closest to `localAngle` (used by AI and auto-placement). */
export function nearestValidSlot(organelles: Organelle[], type: OrganelleType, localAngle: number, preferCenter = false): number | null {
  const slots = validSlots(organelles, type);
  if (!slots.length) return null;
  if (preferCenter && ORGANELLES[type].mount === 'internal' && slots.includes(0)) return 0;
  let best = slots[0];
  let bestD = Infinity;
  for (const s of slots) {
    const a = organelleAngle({ type, slot: s });
    const isCenter = ORGANELLES[type].mount === 'internal' && s === 0;
    const d = isCenter ? Math.PI * 0.9 : Math.abs(Math.atan2(Math.sin(a - localAngle), Math.cos(a - localAngle)));
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
