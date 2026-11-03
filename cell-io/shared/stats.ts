/**
 * Derives a cell's full stat block from biomass, level, mutations and the
 * *placement* of its organelles. This is where layout becomes mechanics:
 * thrust, armor, spikes, venom links and toxin clouds are all directional.
 */
import { radiusFromBiomass } from './constants';
import { angleDiff, softCap } from './math';
import { ORGANELLES, TUNING, type Organelle } from './organelles';
import { INTERNAL_SLOTS, organelleAngle, organelleDirection } from './placement';

export interface Mutations {
  vitality: number;
  metabolism: number;
}

export interface ThrustComponent {
  dir: number; // local direction the push points toward
  amount: number;
  focus: number; // cosine exponent: 1 = broad, 3 = narrow
  isotropic: number; // share of `amount` granted in every direction
}

export interface Delivery {
  kind: 'spikes' | 'stinger';
  dir: number;
  arc: number;
  damage: number;
  bleed: boolean;
  venom: { dps: number; slow: number; potency: number } | null;
}

export interface ArmorArc {
  dir: number;
  halfArc: number;
  reduction: number;
}

export interface ToxinEmitter {
  dir: number; // local angle
  offset: number; // fraction of radius from the center the cloud is centered at
  radius: number;
  dps: number;
}

export interface CellStats {
  radius: number;
  maxHp: number;
  baseSpeed: number;
  accel: number;
  turnRate: number;
  weightMult: number;
  energyMax: number;
  energyRegen: number;
  resistance: number; // global damage reduction 0..1
  regenFrac: number; // fraction of max HP per second (in combat)
  thrust: ThrustComponent[];
  deliveries: Delivery[];
  armor: ArmorArc[];
  toxins: ToxinEmitter[];
  sizeFactor: number; // damage scaling from size
  mass: number;
}

export const EMPTY_MUTATIONS: Mutations = { vitality: 0, metabolism: 0 };

export function computeStats(biomass: number, level: number, organelles: Organelle[], mut: Mutations = EMPTY_MUTATIONS): CellStats {
  const radius = radiusFromBiomass(biomass);
  const sizeRel = radius / 22;

  let weight = 0;
  let upkeep = 0;
  let energyMax = 100 + mut.metabolism * 15;
  let mitoRegen = 0;
  let turnBonus = 0;
  let turnPenalty = 0;
  let accelBonus = 0;
  let resistance = 0;
  let bonusHp = 0;
  let regenFrac = 0;
  const thrust: ThrustComponent[] = [];
  const deliveries: Delivery[] = [];
  const armor: ArmorArc[] = [];
  const toxins: ToxinEmitter[] = [];
  const sacs: { angle: number; centered: boolean; level: number }[] = [];
  let centerMito = false;
  let regenCentered = false;
  let mitoCount = 0;

  for (const o of organelles) {
    const def = ORGANELLES[o.type];
    const li = Math.max(0, Math.min(2, o.level - 1));
    weight += def.weight;
    upkeep += def.upkeep;
    const at = organelleAngle(o);
    const dir = organelleDirection(o);
    switch (o.type) {
      case 'cilia': {
        const eff = TUNING.ciliaEff[li];
        thrust.push({ dir: dir + Math.PI, amount: eff, focus: 1, isotropic: 0.35 });
        // Side-mounted cilia (|sin| = 1) help turning the most.
        turnBonus += eff * (0.4 + 0.9 * Math.abs(Math.sin(at)));
        accelBonus += eff * 0.8;
        break;
      }
      case 'flagellum':
        thrust.push({ dir: dir + Math.PI, amount: TUNING.flagThrust[li], focus: 3, isotropic: 0 });
        turnPenalty += TUNING.flagTurnPenalty[li];
        break;
      case 'spikes':
        deliveries.push({ kind: 'spikes', dir, arc: TUNING.spikeArc, damage: TUNING.spikeDmg[li], bleed: li >= 2, venom: null });
        break;
      case 'stinger':
        deliveries.push({ kind: 'stinger', dir, arc: TUNING.stingerArc[li], damage: TUNING.stingerDmg[li], bleed: false, venom: null });
        break;
      case 'membrane':
        armor.push({ dir: at, halfArc: TUNING.membraneHalfArc, reduction: TUNING.membraneReduction[li] });
        resistance += 0.03;
        bonusHp += 12 + 8 * li;
        break;
      case 'mitochondria':
        mitoRegen += TUNING.mitoRegen[li];
        energyMax += TUNING.mitoEnergy[li];
        mitoCount++;
        if (o.slot === 0) centerMito = true;
        break;
      case 'venom':
        sacs.push({ angle: at, centered: INTERNAL_SLOTS[o.slot].r === 0, level: li });
        break;
      case 'regen':
        regenFrac += TUNING.regenFrac[li] * (o.slot === 0 ? 1.25 : 1);
        if (o.slot === 0) regenCentered = true;
        break;
      case 'toxin': {
        const s = INTERNAL_SLOTS[o.slot];
        toxins.push({ dir: at, offset: s.r === 0 ? 0 : 1.15, radius: TUNING.toxinRadius[li], dps: TUNING.toxinDps[li] });
        break;
      }
    }
  }

  // Link venom sacs to delivery organelles on the same side.
  for (const d of deliveries) {
    let best: Delivery['venom'] = null;
    for (const sac of sacs) {
      let potency = 0;
      if (sac.centered) potency = 0.6;
      else if (Math.abs(angleDiff(sac.angle, d.dir)) <= TUNING.venomLinkArc) potency = 1;
      if (d.kind === 'spikes') potency *= 0.6;
      if (potency <= 0) continue;
      const v = { dps: TUNING.venomDps[sac.level] * potency, slow: TUNING.venomSlow[sac.level], potency };
      if (!best || v.dps > best.dps) best = v;
    }
    d.venom = best;
  }

  // Mitochondria beside the nucleus (center slot, or ringed around a centered regen nucleus).
  if (centerMito || (regenCentered && mitoCount > 0)) regenFrac *= 1.15;

  const weightMult = 1 - softCap(weight, 0.35);
  const mass = biomass * (1 + weight);
  const energyRegen = Math.max(1, 5 + softCap(mitoRegen, 16) - upkeep);
  const baseHp = 80 + biomass * 1.2 + bonusHp;
  const maxHp = baseHp * (1 + 0.1 * mut.vitality);

  return {
    radius,
    maxHp,
    baseSpeed: 235 * Math.pow(sizeRel, -0.45) * weightMult,
    accel: 650 * Math.pow(sizeRel, -0.55) * (1 + softCap(accelBonus, 0.6)) * weightMult,
    turnRate: 5.2 * Math.pow(sizeRel, -0.35) * (1 + softCap(turnBonus, 0.9)) * (1 - softCap(turnPenalty, 0.5)),
    weightMult,
    energyMax,
    energyRegen,
    resistance: softCap(resistance, 0.25),
    regenFrac,
    thrust,
    deliveries,
    armor,
    toxins,
    sizeFactor: Math.min(2.6, Math.pow(sizeRel, 0.55)),
    mass,
  };
}

/**
 * Speed multiplier for moving in `localAngle` (0 = straight ahead).
 * Soft-capped at +80% so stacking cannot produce unlimited speed.
 */
export function thrustMultiplier(stats: CellStats, localAngle: number): number {
  let sum = 0;
  for (const t of stats.thrust) {
    const c = Math.max(0, Math.cos(localAngle - t.dir));
    sum += t.amount * (t.isotropic + (1 - t.isotropic) * Math.pow(c, t.focus));
  }
  return 1 + softCap(sum, 0.8);
}

/** Damage multiplier (0..1) for a hit arriving at `localAngle` on this cell. */
export function armorMultiplier(stats: CellStats, localAngle: number): number {
  let red = 0;
  for (const a of stats.armor) {
    if (Math.abs(angleDiff(a.dir, localAngle)) <= a.halfArc) red = Math.max(red, a.reduction);
  }
  return (1 - red) * (1 - stats.resistance);
}

/** The strongest delivery organelle whose arc contains `localAngle`, if any. */
export function deliveryAt(stats: CellStats, localAngle: number): Delivery | null {
  let best: Delivery | null = null;
  for (const d of stats.deliveries) {
    if (Math.abs(angleDiff(d.dir, localAngle)) <= d.arc && (!best || d.damage > best.damage)) best = d;
  }
  return best;
}

/** Compact summary used by the evolution preview and HUD. */
export function statSummary(stats: CellStats) {
  const dirs = { front: 0, side: Math.PI / 2, rear: Math.PI };
  return {
    speedFront: stats.baseSpeed * thrustMultiplier(stats, dirs.front),
    speedSide: stats.baseSpeed * Math.max(thrustMultiplier(stats, dirs.side), thrustMultiplier(stats, -dirs.side)),
    turnRate: stats.turnRate,
    accel: stats.accel,
    maxHp: stats.maxHp,
    energyMax: stats.energyMax,
    energyRegen: stats.energyRegen,
    armorFront: 1 - armorMultiplier(stats, 0),
    armorSide: 1 - Math.min(armorMultiplier(stats, Math.PI / 2), armorMultiplier(stats, -Math.PI / 2)),
    armorRear: 1 - armorMultiplier(stats, Math.PI),
    spikeFront: deliveryAt(stats, 0)?.damage ?? 0,
    spikeRear: deliveryAt(stats, Math.PI)?.damage ?? 0,
    venomLinked: stats.deliveries.some((d) => d.venom),
    regen: stats.regenFrac * stats.maxHp,
  };
}
export type StatSummary = ReturnType<typeof statSummary>;
