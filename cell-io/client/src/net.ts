/**
 * Client networking: holds the latest authoritative state, buffers snapshots
 * for interpolation and exposes simple callbacks for the UI.
 */
import { io, type Socket } from 'socket.io-client';
import { CELL_FIELDS, CLOUD_FIELDS, NUTRIENT_FIELDS } from '../../shared/protocol';
import type {
  CellInfo,
  ClientToServer,
  DeathStats,
  EvolutionOffer,
  GameEvent,
  Hazard,
  LeaderboardEntry,
  PrivateState,
  ServerToClient,
  Snapshot,
} from '../../shared/protocol';
import { lerp, lerpAngle } from '../../shared/math';

export interface CellSnap {
  id: number;
  x: number;
  y: number;
  heading: number;
  radius: number;
  hp: number;
  flags: number;
  vx: number;
  vy: number;
}

interface BufferedSnap {
  t: number;
  cells: Map<number, CellSnap>;
}

export interface NutrientState {
  id: number;
  x: number;
  y: number;
  kind: number;
}

export interface CloudState {
  id: number;
  x: number;
  y: number;
  r: number;
  life: number;
}

/** Render this far behind the newest snapshot so there are always two to interpolate between. */
const INTERP_DELAY = 110;

export class Net {
  readonly socket: Socket<ServerToClient, ClientToServer>;
  myId = 0;
  worldSize = 4800;
  hazards: Hazard[] = [];
  you: PrivateState | null = null;
  infos = new Map<number, CellInfo>();
  nutrients = new Map<number, NutrientState>();
  clouds: CloudState[] = [];
  leaderboard: LeaderboardEntry[] = [];
  connected = false;
  latestCells = new Map<number, CellSnap>();
  latestArrival = 0;

  private buffer: BufferedSnap[] = [];
  private offset: number | null = null; // serverTime - localTime

  onEvents: (e: GameEvent[]) => void = () => {};
  onOffer: (o: EvolutionOffer) => void = () => {};
  onEvolveResult: (r: { ok: boolean; error?: string }) => void = () => {};
  onDied: (d: DeathStats) => void = () => {};
  onWelcome: () => void = () => {};
  onConnection: (ok: boolean) => void = () => {};
  /** Called with nutrient ids that disappeared since the last nutrient update. */
  onNutrientsRemoved: (ids: number[]) => void = () => {};

  constructor() {
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.socket.on('connect', () => {
      this.connected = true;
      this.onConnection(true);
    });
    this.socket.on('disconnect', () => {
      this.connected = false;
      this.onConnection(false);
    });
    this.socket.on('welcome', (w) => {
      this.myId = w.id;
      this.worldSize = w.worldSize;
      this.hazards = w.hazards;
      this.buffer = [];
      this.onWelcome();
    });
    this.socket.on('snap', (s) => this.ingest(s));
    this.socket.on('events', (e) => this.onEvents(e));
    this.socket.on('leaderboard', (l) => (this.leaderboard = l));
    this.socket.on('evolveOffer', (o) => this.onOffer(o));
    this.socket.on('evolveResult', (r) => this.onEvolveResult(r));
    this.socket.on('died', (d) => {
      this.you = null;
      this.onDied(d);
    });
  }

  private ingest(s: Snapshot) {
    const now = performance.now();
    const off = s.t - now;
    // Smoothed clock offset; jumps (e.g. after a tab was hidden) snap immediately.
    if (this.offset === null || Math.abs(off - this.offset) > 500) this.offset = off;
    else this.offset += (off - this.offset) * 0.08;

    const cells = new Map<number, CellSnap>();
    const a = s.cells;
    for (let i = 0; i + CELL_FIELDS <= a.length; i += CELL_FIELDS) {
      cells.set(a[i], { id: a[i], x: a[i + 1], y: a[i + 2], heading: a[i + 3], radius: a[i + 4], hp: a[i + 5], flags: a[i + 6], vx: a[i + 7], vy: a[i + 8] });
    }
    this.buffer.push({ t: s.t, cells });
    if (this.buffer.length > 40) this.buffer.shift();
    this.latestCells = cells;
    this.latestArrival = now;

    if (s.infos) for (const info of s.infos) this.infos.set(info.id, info);
    this.you = s.you;

    if (s.nutrients) {
      const next = new Map<number, NutrientState>();
      const n = s.nutrients;
      for (let i = 0; i + NUTRIENT_FIELDS <= n.length; i += NUTRIENT_FIELDS) {
        next.set(n[i], { id: n[i], x: n[i + 1], y: n[i + 2], kind: n[i + 3] });
      }
      const removed: number[] = [];
      for (const id of this.nutrients.keys()) if (!next.has(id)) removed.push(id);
      this.nutrients = next;
      if (removed.length) this.onNutrientsRemoved(removed);
    }

    const clouds: CloudState[] = [];
    const c = s.clouds;
    for (let i = 0; i + CLOUD_FIELDS <= c.length; i += CLOUD_FIELDS) clouds.push({ id: c[i], x: c[i + 1], y: c[i + 2], r: c[i + 3], life: c[i + 4] });
    this.clouds = clouds;
  }

  /** Interpolated cells at render time. */
  sample(now: number): Map<number, CellSnap> {
    const out = new Map<number, CellSnap>();
    if (!this.buffer.length || this.offset === null) return out;
    const rt = now + this.offset - INTERP_DELAY;
    let older = this.buffer[0];
    let newer = this.buffer[this.buffer.length - 1];
    for (let i = this.buffer.length - 1; i > 0; i--) {
      if (this.buffer[i - 1].t <= rt) {
        older = this.buffer[i - 1];
        newer = this.buffer[i];
        break;
      }
    }
    const span = newer.t - older.t;
    const f = span > 0 ? Math.max(0, Math.min(1.2, (rt - older.t) / span)) : 1;
    for (const [id, n] of newer.cells) {
      const o = older.cells.get(id);
      if (!o) {
        out.set(id, n);
        continue;
      }
      out.set(id, {
        ...n,
        x: lerp(o.x, n.x, f),
        y: lerp(o.y, n.y, f),
        heading: lerpAngle(o.heading, n.heading, Math.min(1, f)),
        radius: lerp(o.radius, n.radius, Math.min(1, f)),
        hp: lerp(o.hp, n.hp, Math.min(1, f)),
      });
    }
    return out;
  }

  join(name: string) {
    this.socket.emit('join', { name });
  }
  sendInput(a: number, t: number) {
    this.socket.emit('input', { a, t });
  }
  sendView(w: number, h: number) {
    this.socket.emit('view', { w, h });
  }
}
