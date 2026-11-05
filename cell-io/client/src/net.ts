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
import { Predictor } from './predict';

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
  readonly predictor = new Predictor();
  /** Network stats for the F3 overlay. */
  readonly stats = { ping: 0, snapRate: 0, bufferMs: 0, nutrientRecords: 0, snapTimes: [] as number[] };

  onEvents: (e: GameEvent[]) => void = () => {};
  onOffer: (o: EvolutionOffer) => void = () => {};
  onEvolveResult: (r: { ok: boolean; error?: string }) => void = () => {};
  onDied: (d: DeathStats) => void = () => {};
  onWelcome: () => void = () => {};
  onConnection: (ok: boolean) => void = () => {};
  /** Called with nutrient ids that disappeared since the last nutrient update. */
  onNutrientsRemoved: (ids: number[]) => void = () => {};

  /** Pass a socket-like object to run against an in-browser server (offline build). */
  constructor(socket?: Socket<ServerToClient, ClientToServer>) {
    this.socket = socket ?? io({ transports: ['websocket', 'polling'] });
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
      this.predictor.reset();
      this.onWelcome();
    });
    this.socket.on('snap', (s) => this.ingest(s));
    this.socket.on('events', (e) => this.onEvents(e));
    this.socket.on('leaderboard', (l) => (this.leaderboard = l));
    this.socket.on('evolveOffer', (o) => this.onOffer(o));
    this.socket.on('evolveResult', (r) => this.onEvolveResult(r));
    this.socket.on('died', (d) => {
      this.you = null;
      this.predictor.reset();
      this.onDied(d);
    });
    this.socket.on('netPong', (t) => {
      const rtt = performance.now() - t;
      this.stats.ping = this.stats.ping ? this.stats.ping * 0.7 + rtt * 0.3 : rtt;
    });
    setInterval(() => {
      if (this.connected) this.socket.emit('netPing', performance.now());
    }, 1000);
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
    if (s.you) {
      const mine = this.infos.get(this.myId);
      this.predictor.setStats(s.you, mine?.organelles ?? [], mine?.cracks ?? []);
      this.predictor.reconcile(s.you, this.hazards);
    }
    const st = this.stats;
    st.snapTimes.push(now);
    while (st.snapTimes.length && now - st.snapTimes[0] > 1000) st.snapTimes.shift();
    st.snapRate = st.snapTimes.length;

    // Nutrient deltas.
    const removed: number[] = [];
    if (s.nFull) {
      removed.push(...this.nutrients.keys());
      this.nutrients.clear();
    }
    const add = s.nAdd ?? [];
    for (let i = 0; i + NUTRIENT_FIELDS <= add.length; i += NUTRIENT_FIELDS) {
      this.nutrients.set(add[i], { id: add[i], x: add[i + 1], y: add[i + 2], kind: add[i + 3] });
    }
    for (const id of s.nDel ?? []) {
      if (this.nutrients.delete(id)) removed.push(id);
    }
    st.nutrientRecords += add.length / NUTRIENT_FIELDS + (s.nDel?.length ?? 0);
    if (removed.length) this.onNutrientsRemoved(removed.filter((id) => !this.nutrients.has(id)));

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
    this.stats.bufferMs = this.buffer[this.buffer.length - 1].t - rt;
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

  join(name: string, tutorial = false) {
    this.socket.emit('join', { name, tutorial });
  }
  /** Send steering intent; the predictor records it under a fresh sequence number. */
  sendInput(a: number, t: number) {
    const seq = this.predictor.pushInput(a, t);
    this.socket.emit('input', { a, t, seq });
  }
  sendView(w: number, h: number) {
    this.socket.emit('view', { w, h });
  }
}
