import { radiusFromBiomass, START_BIOMASS } from '../constants';
import type { Organelle } from '../organelles';
import type { Offer } from '../progression';
import { computeStats, type CellStats, type Mutations } from '../stats';
import { crackStage, DAMAGEABLE, disabledFlags, integrityMax, type OrganelleHealth } from '../integrity';
import type { AIState } from './ai';

export interface Cell {
  id: number;
  kind: 'player' | 'ai';
  name: string;
  hue: number;
  alive: boolean;

  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;

  biomass: number;
  xp: number;
  level: number;
  hp: number;
  energy: number;

  organelles: Organelle[];
  /** Integrity per organelle (same order as `organelles`). */
  orgHealth: OrganelleHealth[];
  /** Crack stages last published to clients, to know when to bump infoVersion. */
  crackKey: string;
  mutations: Mutations;
  stats: CellStats;
  infoVersion: number;

  input: { a: number; t: number };
  /** Last input sequence applied and the world time it arrived (for prediction acks). */
  inputSeq: number;
  inputAt: number;
  dashCd: number;
  dashTime: number;
  toxinCd: number;
  venomCd: number;
  venomSurge: number;

  poison: { stacks: number; time: number; dps: number; slow: number; source: number };
  bleed: { time: number; dps: number; source: number };
  dotAccum: number;
  dotTimer: number;

  spawnProtect: number;
  evolveProtect: number;
  evolveProtectGranted: boolean;
  evolving: boolean;
  pendingEvolutions: number;
  offers: Offer[] | null;

  lastHitBy: number | null;
  lastHitAt: number;
  lastCombatAt: number;
  regenActive: boolean;
  pairCooldown: Map<number, number>;

  kills: number;
  bornAt: number;
  biomassCollected: number;
  peakBiomass: number;

  ai?: AIState;
}

export function createCell(id: number, kind: Cell['kind'], name: string, x: number, y: number, now: number, biomass = START_BIOMASS): Cell {
  const mutations = { vitality: 0, metabolism: 0 };
  const stats = computeStats(biomass, 1, [], mutations);
  return {
    id,
    kind,
    name,
    hue: Math.floor(Math.random() * 360),
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    heading: Math.random() * Math.PI * 2,
    biomass,
    xp: 0,
    level: 1,
    hp: stats.maxHp,
    energy: stats.energyMax,
    organelles: [],
    orgHealth: [],
    crackKey: '',
    mutations,
    stats,
    infoVersion: 1,
    input: { a: 0, t: 0 },
    inputSeq: 0,
    inputAt: now,
    dashCd: 0,
    dashTime: 0,
    toxinCd: 0,
    venomCd: 0,
    venomSurge: 0,
    poison: { stacks: 0, time: 0, dps: 0, slow: 0, source: 0 },
    bleed: { time: 0, dps: 0, source: 0 },
    dotAccum: 0,
    dotTimer: 0,
    spawnProtect: 0,
    evolveProtect: 0,
    evolveProtectGranted: false,
    evolving: false,
    pendingEvolutions: 0,
    offers: null,
    lastHitBy: null,
    lastHitAt: -1e9,
    lastCombatAt: -1e9,
    regenActive: false,
    pairCooldown: new Map(),
    kills: 0,
    bornAt: now,
    biomassCollected: 0,
    peakBiomass: biomass,
  };
}

/** Recompute derived stats after growth or an organelle change, preserving damage taken. */
export function refreshStats(c: Cell) {
  syncHealth(c);
  const oldMax = c.stats.maxHp;
  c.stats = computeStats(c.biomass, c.level, c.organelles, c.mutations, disabledFlags(c.orgHealth));
  if (c.level >= 20) c.stats.maxHp *= 1.15;
  const delta = c.stats.maxHp - oldMax;
  if (delta > 0) c.hp += delta;
  c.hp = Math.min(c.hp, c.stats.maxHp);
  c.energy = Math.min(c.energy, c.stats.energyMax);
}

/** Keep `orgHealth` aligned with `organelles`; growth raises max integrity proportionally. */
export function syncHealth(c: Cell) {
  const radius = computeRadius(c);
  for (let i = 0; i < c.organelles.length; i++) {
    const o = c.organelles[i];
    const max = DAMAGEABLE.has(o.type) ? integrityMax(o, radius) : 0;
    const h = c.orgHealth[i];
    if (!h) c.orgHealth[i] = { hp: max, max, regrow: 0 };
    else if (h.max !== max) {
      h.hp = h.max > 0 ? (h.hp / h.max) * max : max;
      h.max = max;
    }
  }
  c.orgHealth.length = c.organelles.length;
}

function computeRadius(c: Cell) {
  return radiusFromBiomass(c.biomass);
}

/** Crack stages per organelle (0 intact .. 3 broken), for CellInfo. */
export function crackStages(c: Cell): number[] {
  return c.orgHealth.map((h) => crackStage(h));
}
