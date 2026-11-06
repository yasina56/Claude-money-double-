/** Wire protocol between client and server (Socket.IO event payloads). */
import type { Organelle } from './organelles';
import type { Offer } from './progression';

export const CellFlag = {
  SpawnProtected: 1,
  Evolving: 2,
  Poisoned: 4,
  Dashing: 8,
  AI: 16,
  Regenerating: 32,
  Slowed: 64,
  Bleeding: 128,
  VenomSurge: 256,
} as const;

/** Flat cell record in snapshots: [id, x, y, heading, radius, hpFrac, flags, vx, vy]. */
export const CELL_FIELDS = 9;
/** Flat nutrient record: [id, x, y, kind] (kind: 0-4 color variants, 5 = evolution crystal). */
export const NUTRIENT_FIELDS = 4;
/** Flat cloud record: [id, x, y, radius, lifeFrac]. */
export const CLOUD_FIELDS = 5;

export interface Hazard {
  kind: 'acid' | 'current';
  x: number;
  y: number;
  r: number;
  /** For currents: push direction (radians) and strength (px/s). */
  dir?: number;
  strength?: number;
}

export interface CellInfo {
  id: number;
  name: string;
  hue: number;
  level: number;
  ai: boolean;
  organelles: Organelle[];
  /** Per-organelle crack stage: 0 intact, 1-2 cracked, 3 broken (regrowing). */
  cracks: number[];
  version: number;
}

export interface PrivateState {
  hp: number;
  maxHp: number;
  energy: number;
  energyMax: number;
  xp: number;
  xpNext: number;
  level: number;
  biomass: number;
  kills: number;
  pendingEvolutions: number;
  dashCd: number;
  dashMaxCd: number;
  toxinCd: number;
  hasToxin: boolean;
  venomCd: number;
  venomSurge: number;
  hasVenom: boolean;
  /** Seconds until you are out of combat long enough to evolve (0 = free to evolve). */
  combatLock: number;
  capacity: number;
  capacityUsed: number;
  protectedFor: number;
  apex: boolean;
  /** Exact authoritative body for client-side prediction / reconciliation. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  /** Sequence number of the last input the server applied, and how long ago (s) it was applied. */
  ack: number;
  ackAge: number;
  /** Movement modifiers the predictor must apply. */
  slow: number;
  evolving: boolean;
  mutations: { vitality: number; metabolism: number };
}

export interface Snapshot {
  t: number; // server time (ms)
  cells: number[];
  /** Nutrient deltas: records entering the view, ids leaving it. `nFull` means start from an empty set. */
  nAdd?: number[];
  nDel?: number[];
  nFull?: boolean;
  clouds: number[];
  you: PrivateState | null;
  infos?: CellInfo[];
}

export type GameEvent =
  | { e: 'hit'; x: number; y: number; target: number; source: number; amount: number; kind: 'spike' | 'bump' | 'sting' | 'dot' | 'toxin' | 'acid'; blocked: boolean }
  | { e: 'death'; id: number; x: number; y: number; hue: number; r: number }
  | { e: 'eat'; id: number; nutrient: number; crystal: boolean }
  | { e: 'level'; id: number; level: number }
  | { e: 'dash'; id: number }
  | { e: 'toxin'; id: number; x: number; y: number }
  | { e: 'break'; id: number; x: number; y: number; type: string }
  | { e: 'regrow'; id: number; type: string }
  | { e: 'venom'; id: number }
  | { e: 'kill'; killer: string; victim: string; how: string };

export interface EvolutionOffer {
  offers: Offer[];
  protectedFor: number;
}

export interface DeathStats {
  survivalTime: number;
  level: number;
  kills: number;
  biomassCollected: number;
  peakBiomass: number;
  killedBy: string | null;
  /** Cell id the camera follows for SPECTATE_SECONDS after death. */
  killerId: number | null;
}

export interface LeaderboardEntry {
  id: number;
  name: string;
  biomass: number;
  kills: number;
  level: number;
}

export interface Welcome {
  id: number;
  worldSize: number;
  hazards: Hazard[];
  roomId: string;
}

export interface EvolveChoice {
  index: number;
  slot?: number;
  tilt?: number;
}

export interface ClientToServer {
  /** `tutorial` asks for the first-play tutorial boost (honored for a fresh level-1 cell only). */
  join: (data: { name: string; tutorial?: boolean }) => void;
  /** Steering intent. `seq` increases with every message and is echoed back as `ack`. */
  input: (data: { a: number; t: number; seq: number }) => void;
  view: (data: { w: number; h: number }) => void;
  ability: (data: { key: 'dash' | 'toxin' | 'venom' }) => void;
  evolveOpen: () => void;
  evolveClose: () => void;
  evolveChoose: (data: EvolveChoice) => void;
  respawn: () => void;
  /** Latency probe; the server echoes `t` back in `netPong`. */
  netPing: (t: number) => void;
  /** Development only (server started with CELLIO_DEV=1): grant XP. */
  devXp: (amount: number) => void;
  /** Development only: teleport next to the nearest other player. */
  devTp: () => void;
}

export interface ServerToClient {
  welcome: (w: Welcome) => void;
  snap: (s: Snapshot) => void;
  events: (e: GameEvent[]) => void;
  leaderboard: (l: LeaderboardEntry[]) => void;
  evolveOffer: (o: EvolutionOffer) => void;
  evolveResult: (r: { ok: boolean; error?: string }) => void;
  died: (d: DeathStats) => void;
  netPong: (t: number) => void;
}
