/**
 * Organelle catalogue. Every organelle has a slot cost (capacity), a weight
 * (speed penalty), an energy upkeep and per-level numbers. The numbers here are
 * the single source of truth for both the server simulation and the client UI.
 */

export type OrganelleType =
  | 'cilia'
  | 'spikes'
  | 'stinger'
  | 'membrane'
  | 'mitochondria'
  | 'venom'
  | 'regen'
  | 'flagellum'
  | 'toxin';

export type Mount = 'surface' | 'internal';

/** A placed organelle. `slot` is a surface snap index or internal slot index; `tilt` is radians. */
export interface Organelle {
  type: OrganelleType;
  level: number; // 1..3
  slot: number;
  tilt: number;
}

export interface OrganelleDef {
  type: OrganelleType;
  name: string;
  role: string;
  mount: Mount;
  /** Surface snaps occupied (1 or 3). Internal organelles always use 1 internal slot. */
  span: number;
  slotCost: number;
  weight: number;
  upkeep: number; // energy per second
  unlockLevel: number;
  color: number;
  levelNames: [string, string, string];
  levelText: [string, string, string];
  placement: string;
  strengths: string;
  weaknesses: string;
}

export const ORGANELLES: Record<OrganelleType, OrganelleDef> = {
  cilia: {
    type: 'cilia',
    name: 'Cilia',
    role: 'Movement',
    mount: 'surface',
    span: 1,
    slotCost: 1,
    weight: 0.01,
    upkeep: 0.25,
    unlockLevel: 2,
    color: 0xb8f7ff,
    levelNames: ['Cilia', 'Beating Cilia', 'Power Cilia'],
    levelText: ['+9% movement effectiveness', '+17% movement effectiveness', '+28% movement effectiveness'],
    placement:
      'Pushes the cell away from the side it sits on. Rear cilia add forward speed; side cilia add turning; a ring of cilia gives all-round agility.',
    strengths: 'Cheap, light, stacks into agile builds.',
    weaknesses: 'Bonuses soft-cap; no damage or defense.',
  },
  spikes: {
    type: 'spikes',
    name: 'Spikes',
    role: 'Physical damage',
    mount: 'surface',
    span: 1,
    slotCost: 1,
    weight: 0.02,
    upkeep: 0,
    unlockLevel: 2,
    color: 0xfff1d6,
    levelNames: ['Short Spikes', 'Reinforced Spikes', 'Barbed Spikes'],
    levelText: [
      'Contact damage in the pointed direction, scales with impact speed',
      '+52% spike damage',
      '+111% spike damage, hits cause bleeding',
    ],
    placement:
      'Only hits that land within the spike’s arc deal damage. Front spikes reward ramming; rear spikes punish chasers. Tilt aims them.',
    strengths: 'High burst damage on accurate, fast impacts.',
    weaknesses: 'Useless at low impact speed or when hit from another side; weakened by armor.',
  },
  stinger: {
    type: 'stinger',
    name: 'Stinger',
    role: 'Venom delivery',
    mount: 'surface',
    span: 1,
    slotCost: 1,
    weight: 0.01,
    upkeep: 0,
    unlockLevel: 4,
    color: 0xe2b6ff,
    levelNames: ['Stinger', 'Hollow Stinger', 'Injector'],
    levelText: ['Small contact damage; delivers venom at full potency', '+30% damage, wider arc', '+60% damage, wider arc'],
    placement: 'Narrow arc. Connects to a venom sac placed on the same side (or a centered sac at reduced potency).',
    strengths: 'Delivers venom reliably, even on light touches.',
    weaknesses: 'Very little damage on its own.',
  },
  membrane: {
    type: 'membrane',
    name: 'Reinforced Membrane',
    role: 'Defense',
    mount: 'surface',
    span: 3,
    slotCost: 2,
    weight: 0.06,
    upkeep: 0,
    unlockLevel: 2,
    color: 0x7fa6d9,
    levelNames: ['Plated Membrane', 'Layered Membrane', 'Chitin Shell'],
    levelText: ['-34% damage from the covered side', '-47% damage from the covered side', '-56% damage from the covered side'],
    placement: 'Covers a ~70° arc. Face it toward threats: front armor for rammers, rear armor for escaping.',
    strengths: 'Hard counter to spikes from the covered direction; +HP.',
    weaknesses: 'Heavy: slows the cell. Uncovered sides stay vulnerable.',
  },
  mitochondria: {
    type: 'mitochondria',
    name: 'Mitochondria',
    role: 'Energy',
    mount: 'internal',
    span: 1,
    slotCost: 1,
    weight: 0.01,
    upkeep: 0,
    unlockLevel: 2,
    color: 0xff9d4d,
    levelNames: ['Mitochondria', 'Dense Mitochondria', 'Hyper Mitochondria'],
    levelText: ['+3 energy/s, +10 max energy', '+5 energy/s, +15 max energy', '+7.5 energy/s, +22 max energy'],
    placement: 'Internal. Placed beside the nucleus (center) it also boosts regeneration by 15%.',
    strengths: 'More dashes, toxin clouds and venom.',
    weaknesses: 'No direct combat value.',
  },
  venom: {
    type: 'venom',
    name: 'Venom Sac',
    role: 'Poison',
    mount: 'internal',
    span: 1,
    slotCost: 2,
    weight: 0.02,
    upkeep: 0.2,
    unlockLevel: 4,
    color: 0xb04dff,
    levelNames: ['Venom Sac', 'Paralytic Venom', 'Necrotic Venom'],
    levelText: [
      'Spikes/stingers on its side poison targets: 2.8 dmg/s per stack (max 3). [R] Venom surge',
      '4.2 dmg/s per stack, slows poisoned enemies 15%',
      '5.6 dmg/s per stack, slows poisoned enemies 25%',
    ],
    placement:
      'Needs a delivery organelle (stinger or spikes) within 70° of its side. A centered sac links to everything at 60% potency.',
    strengths: 'Sustained damage that outlasts armor and burst.',
    weaknesses: 'No delivery, no poison. Costs energy per application. Slow to kill.',
  },
  regen: {
    type: 'regen',
    name: 'Regeneration Nucleus',
    role: 'Healing',
    mount: 'internal',
    span: 1,
    slotCost: 2,
    weight: 0.03,
    upkeep: 0,
    unlockLevel: 4,
    color: 0x5dff9a,
    levelNames: ['Regen Nucleus', 'Vital Nucleus', 'Phoenix Nucleus'],
    levelText: ['Heals 0.5% max HP/s, x3 out of combat', 'Heals 0.75% max HP/s, x3 out of combat', 'Heals 1.1% max HP/s, x3 out of combat'],
    placement: 'Internal. In the center slot it is shielded and heals 25% more.',
    strengths: 'Wins long fights and lets you re-engage.',
    weaknesses: 'Consumes energy while healing; slow in combat.',
  },
  flagellum: {
    type: 'flagellum',
    name: 'Flagellum',
    role: 'Directional speed',
    mount: 'surface',
    span: 1,
    slotCost: 2,
    weight: 0.02,
    upkeep: 0.5,
    unlockLevel: 7,
    color: 0xffe066,
    levelNames: ['Flagellum', 'Whip Flagellum', 'Turbo Flagellum'],
    levelText: ['+35% thrust opposite its mount, -16% turning', '+45% thrust, -13% turning', '+55% thrust, -10% turning'],
    placement: 'Thrusts away from where it is attached. Mount at the rear for raw speed; tilt to curve. Narrow thrust cone.',
    strengths: 'Best straight-line speed: escape or run down prey.',
    weaknesses: 'Hurts turning. Off-axis movement gets no benefit.',
  },
  toxin: {
    type: 'toxin',
    name: 'Toxin Gland',
    role: 'Area defense',
    mount: 'internal',
    span: 1,
    slotCost: 2,
    weight: 0.03,
    upkeep: 0,
    unlockLevel: 7,
    color: 0xc6ff3d,
    levelNames: ['Toxin Gland', 'Caustic Gland', 'Miasma Gland'],
    levelText: ['[Q] Toxic cloud: 10 dmg/s for 4 s, slows 20%', '[Q] 13.5 dmg/s, larger cloud', '[Q] 17 dmg/s, larger cloud'],
    placement: 'Internal. The cloud is released on the gland’s side: centered glands surround you, edge glands project the cloud outward.',
    strengths: 'Zone control; punishes chasers and huggers.',
    weaknesses: '35 energy, 9s cooldown; easy to walk out of.',
  },
};

export const ORGANELLE_TYPES = Object.keys(ORGANELLES) as OrganelleType[];

/** Per-level numbers used by stats.ts and the server. Index 0 = level 1. */
export const TUNING = {
  ciliaEff: [0.09, 0.17, 0.28],
  spikeDmg: [11.5, 17.5, 24],
  spikeArc: (22 * Math.PI) / 180,
  spikeLength: [0.35, 0.45, 0.55],
  stingerDmg: [5, 6.5, 8],
  stingerArc: [(15 * Math.PI) / 180, (19 * Math.PI) / 180, (23 * Math.PI) / 180],
  membraneReduction: [0.34, 0.47, 0.56],
  membraneHalfArc: (36 * Math.PI) / 180,
  mitoRegen: [3, 5, 7.5],
  mitoEnergy: [10, 15, 22],
  venomDps: [2.8, 4.2, 5.6],
  venomSlow: [0, 0.15, 0.25],
  venomDuration: 4,
  venomMaxStacks: 3,
  venomCost: 5,
  venomLinkArc: (70 * Math.PI) / 180,
  /** Venom sac active ability: next N seconds of linked hits inject double poison. */
  venomSurgeCost: 25,
  venomSurgeCooldown: 10,
  venomSurgeDuration: 3,
  regenFrac: [0.005, 0.0075, 0.011],
  regenEnergyPerSec: 1.4,
  flagThrust: [0.35, 0.45, 0.55],
  flagTurnPenalty: [0.16, 0.13, 0.1],
  toxinDps: [10, 13.5, 17],
  /** Enemies inside a toxin cloud move this much slower. */
  toxinSlow: 0.2,
  /** Extra cloud radius (in cell radii) for a centered gland; edge glands get 0.5. */
  toxinCenterReach: 0.4,
  /** Blunt collision damage per px/s of closing speed above 90. */
  bumpFactor: 0.03,
  toxinRadius: [80, 100, 120],
  toxinCost: 35,
  toxinCooldown: 13,
  toxinDuration: 4,
};
