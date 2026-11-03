/**
 * Organelle integrity. Spikes, stingers and reinforced membranes can be
 * broken by hits landing on their side; broken organelles stop working and
 * regrow after REGROW_TIME. This makes facing (and protecting) your weapon
 * side a real decision.
 */
import { angleDiff } from './math';
import { TUNING, type Organelle, type OrganelleType } from './organelles';
import { organelleAngle, organelleDirection } from './placement';

export const DAMAGEABLE: ReadonlySet<OrganelleType> = new Set(['spikes', 'stinger', 'membrane']);

/** Base integrity per level, scaled by sqrt(radius / 22). */
const BASE: Partial<Record<OrganelleType, [number, number, number]>> = {
  spikes: [34, 48, 66],
  stinger: [24, 32, 42],
  membrane: [60, 84, 112],
};

export const REGROW_TIME = 12; // seconds a broken organelle needs to regrow
export const INTEGRITY_HEAL = 0.04; // fraction of max per second when out of combat
/** Share of a hit's raw (pre-armor) damage that the organelles at the contact point absorb. */
export const SOAK = { membrane: 0.8, weapon: 0.45, chipOnArmor: 0.5 };

export interface OrganelleHealth {
  hp: number;
  max: number;
  /** Seconds until a broken organelle regrows (0 when intact). */
  regrow: number;
}

export function integrityMax(o: Organelle, radius: number): number {
  const base = BASE[o.type];
  if (!base) return 0;
  return base[Math.max(0, Math.min(2, o.level - 1))] * Math.sqrt(radius / 22);
}

/** Does a hit arriving at `localAngle` land on this organelle? */
export function coversAngle(o: Organelle, localAngle: number): boolean {
  if (o.type === 'membrane') return Math.abs(angleDiff(organelleAngle(o), localAngle)) <= TUNING.membraneHalfArc;
  if (o.type === 'spikes') return Math.abs(angleDiff(organelleDirection(o), localAngle)) <= TUNING.spikeArc + 0.15;
  if (o.type === 'stinger') return Math.abs(angleDiff(organelleDirection(o), localAngle)) <= TUNING.stingerArc[o.level - 1] + 0.15;
  return false;
}

/** 0 intact, 1-2 cracked, 3 broken. Sent to clients for visuals. */
export function crackStage(h: OrganelleHealth | undefined): number {
  if (!h || h.max <= 0) return 0;
  if (h.regrow > 0) return 3;
  const f = h.hp / h.max;
  return f > 0.66 ? 0 : f > 0.33 ? 1 : 2;
}

export function disabledFlags(health: readonly OrganelleHealth[]): boolean[] {
  return health.map((h) => h.regrow > 0);
}
