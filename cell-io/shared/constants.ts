export const WORLD_SIZE = 4800;
export const TICK_RATE = 40; // simulation steps per second
export const SNAPSHOT_EVERY = 2; // send a snapshot every N ticks (20 Hz)
export const NUTRIENT_EVERY = 4; // resend visible nutrients every N ticks (10 Hz)

export const NUTRIENT_TARGET = 2100;
export const CRYSTAL_TARGET = 30;
export const NUTRIENT_RADIUS = 6;
export const CRYSTAL_RADIUS = 9;
export const CRYSTAL_XP = 8;

export const START_BIOMASS = 10;
export const MAX_BIOMASS = 2600;
export const BIOMASS_DECAY_START = 350; // above this, biomass slowly decays
export const BIOMASS_DECAY_RATE = 0.0025; // fraction of the excess per second

export const SPAWN_PROTECTION = 5; // seconds
export const EVOLVE_PROTECTION = 12; // seconds of protection while customizing
export const EVOLVE_SLOW = 0.45; // speed multiplier while customizing
export const COMBAT_TIMEOUT = 4; // seconds without damage before "out of combat"
export const KILL_CREDIT_WINDOW = 10;
export const MAX_HIT_FRACTION = 0.3; // a single hit can never remove more than this share of max HP
export const PAIR_HIT_COOLDOWN = 0.35;

export const DASH_COST = 28;
export const DASH_COOLDOWN = 2.6;
export const DASH_IMPULSE = 380;

export const MAX_PLAYERS_PER_ROOM = 40;
export const NAME_MAX = 16;

export function radiusFromBiomass(biomass: number): number {
  return 14 + Math.sqrt(Math.max(0, biomass)) * 2.6;
}

/**
 * Camera zoom for a given cell radius and screen size. Shared so the server
 * can compute each client's area of interest exactly as the client renders it.
 */
export function cameraZoom(radius: number, screenW: number, screenH: number): number {
  const screenScale = Math.sqrt((screenW * screenH) / (1280 * 720));
  const z = 1.65 * Math.pow(22 / radius, 0.5) * screenScale;
  return Math.max(0.42 * screenScale, Math.min(1.8 * screenScale, z));
}
