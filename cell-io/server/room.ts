/**
 * A Room owns one World and the sockets playing in it. It runs the fixed-rate
 * simulation loop and sends each client an area-of-interest snapshot.
 * RoomManager hands out rooms, so matchmaking can be added later.
 */
import type { Server, Socket } from 'socket.io';
import {
  cameraZoom,
  MAX_PLAYERS_PER_ROOM,
  NAME_MAX,
  NUTRIENT_EVERY,
  SNAPSHOT_EVERY,
  TICK_RATE,
} from '../shared/constants';
import { capacityForLevel, capacityUsed } from '../shared/placement';
import { APEX_LEVEL, xpToNext } from '../shared/progression';
import { CellFlag, type CellInfo, type ClientToServer, type GameEvent, type LeaderboardEntry, type PrivateState, type ServerToClient, type Snapshot } from '../shared/protocol';
import { DASH_COOLDOWN } from '../shared/constants';
import { AI_POPULATION, spawnAI, updateAI, type Archetype } from './ai';
import type { Cell } from './cell';
import { World } from './world';

type GameSocket = Socket<ClientToServer, ServerToClient>;

interface Client {
  socket: GameSocket;
  name: string;
  cellId: number | null;
  view: { w: number; h: number };
  lastPos: { x: number; y: number };
  known: Map<number, number>; // cell id -> info version the client has
  inputCount: number;
  inputWindowStart: number;
}

export class Room {
  readonly world = new World();
  readonly clients = new Map<string, Client>();
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastStep = performance.now();
  private aiRespawnQueue: { archetype: Archetype; at: number }[] = [];
  private leaderboardTimer = 0;

  constructor(
    readonly id: string,
    private io: Server<ClientToServer, ServerToClient>,
  ) {
    this.world.onDeath = (cell, stats) => {
      if (cell.kind === 'ai' && cell.ai) {
        this.aiRespawnQueue.push({ archetype: cell.ai.archetype, at: this.world.time + 3 + Math.random() * 5 });
      } else {
        for (const cl of this.clients.values()) {
          if (cl.cellId === cell.id) {
            cl.cellId = null;
            cl.lastPos = { x: cell.x, y: cell.y };
            cl.socket.emit('died', stats);
          }
        }
      }
    };
    for (const [arch, n] of Object.entries(AI_POPULATION) as [Archetype, number][]) {
      for (let i = 0; i < n; i++) spawnAI(this.world, arch);
    }
  }

  get playerCount() {
    return this.clients.size;
  }

  start() {
    this.lastStep = performance.now();
    this.timer = setInterval(() => this.update(), 1000 / TICK_RATE);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  addClient(socket: GameSocket) {
    const client: Client = {
      socket,
      name: 'Cell',
      cellId: null,
      view: { w: 1280, h: 720 },
      lastPos: { x: this.world.size / 2, y: this.world.size / 2 },
      known: new Map(),
      inputCount: 0,
      inputWindowStart: 0,
    };
    this.clients.set(socket.id, client);
    socket.join(this.id);

    const cellOf = () => (client.cellId ? this.world.cells.get(client.cellId) : undefined);

    socket.on('join', (data) => {
      client.name = sanitizeName(data?.name);
      this.spawnPlayer(client);
    });
    socket.on('respawn', () => {
      if (!cellOf()) this.spawnPlayer(client);
    });
    socket.on('view', (v) => {
      client.view = { w: clampNum(v?.w, 320, 3840, 1280), h: clampNum(v?.h, 240, 2160, 720) };
    });
    socket.on('input', (inp) => {
      // Basic flood protection: ignore input beyond 60 messages/second.
      const now = Date.now();
      if (now - client.inputWindowStart > 1000) {
        client.inputWindowStart = now;
        client.inputCount = 0;
      }
      if (++client.inputCount > 60) return;
      const c = cellOf();
      if (!c) return;
      const a = Number(inp?.a);
      const t = Number(inp?.t);
      if (!Number.isFinite(a) || !Number.isFinite(t)) return;
      c.input.a = a;
      c.input.t = Math.max(0, Math.min(1, t));
    });
    socket.on('ability', (d) => {
      const c = cellOf();
      if (!c) return;
      if (d?.key === 'dash') this.world.dash(c);
      else if (d?.key === 'toxin') this.world.toxin(c);
    });
    socket.on('evolveOpen', () => {
      const c = cellOf();
      if (!c) return;
      const offers = this.world.openEvolution(c);
      if (offers) socket.emit('evolveOffer', { offers, protectedFor: c.evolveProtect });
    });
    socket.on('evolveClose', () => {
      const c = cellOf();
      if (c) this.world.closeEvolution(c);
    });
    socket.on('evolveChoose', (choice) => {
      const c = cellOf();
      if (!c) return;
      const err = this.world.chooseEvolution(c, {
        index: Number(choice?.index),
        slot: choice?.slot === undefined ? undefined : Number(choice.slot),
        tilt: choice?.tilt === undefined ? undefined : Number(choice.tilt),
      });
      socket.emit('evolveResult', err ? { ok: false, error: err } : { ok: true });
      if (!err && c.offers) socket.emit('evolveOffer', { offers: c.offers, protectedFor: c.evolveProtect });
    });
    if (process.env.CELLIO_DEV === '1') {
      socket.on('devXp', (amount) => {
        const c = cellOf();
        if (c) this.world.addXp(c, Math.max(0, Math.min(5000, Number(amount) || 0)));
      });
      socket.on('devTp', () => {
        const c = cellOf();
        const other = [...this.world.cells.values()].find((o) => o !== c && o.kind === 'player');
        if (c && other) {
          c.x = other.x - other.stats.radius - c.stats.radius - 120;
          c.y = other.y;
        }
      });
    }
    socket.on('disconnect', () => {
      const c = cellOf();
      if (c) this.world.removeCell(c.id);
      this.clients.delete(socket.id);
    });

    socket.emit('welcome', { id: 0, worldSize: this.world.size, hazards: this.world.hazards, roomId: this.id });
  }

  private spawnPlayer(client: Client) {
    const old = client.cellId ? this.world.cells.get(client.cellId) : undefined;
    if (old) this.world.removeCell(old.id);
    const c = this.world.addCell('player', client.name);
    client.cellId = c.id;
    client.known.clear();
    client.socket.emit('welcome', { id: c.id, worldSize: this.world.size, hazards: this.world.hazards, roomId: this.id });
  }

  private update() {
    const now = performance.now();
    // Fixed timestep; never simulate more than 0.1 s per tick after a stall.
    const dt = Math.min(0.1, (now - this.lastStep) / 1000);
    this.lastStep = now;
    this.stepOnce(dt);
  }

  /** One simulation tick plus networking. Exposed for tests. */
  stepOnce(dt: number) {
    for (const c of this.world.cells.values()) if (c.ai && c.alive) updateAI(this.world, c, dt);
    this.world.step(dt);
    this.tick++;

    this.aiRespawnQueue = this.aiRespawnQueue.filter((q) => {
      if (q.at > this.world.time) return true;
      spawnAI(this.world, q.archetype);
      return false;
    });

    if (this.tick % SNAPSHOT_EVERY === 0) {
      const events = this.world.events;
      this.world.events = [];
      for (const client of this.clients.values()) this.sendSnapshot(client, events);
    }
    this.leaderboardTimer += dt;
    if (this.leaderboardTimer >= 1) {
      this.leaderboardTimer = 0;
      this.io.to(this.id).emit('leaderboard', this.leaderboard());
    }
  }

  leaderboard(): LeaderboardEntry[] {
    return [...this.world.cells.values()]
      .filter((c) => c.alive)
      .sort((a, b) => b.biomass - a.biomass)
      .slice(0, 10)
      .map((c) => ({ id: c.id, name: c.name, biomass: Math.round(c.biomass), kills: c.kills, level: c.level }));
  }

  private sendSnapshot(client: Client, events: GameEvent[]) {
    const me = client.cellId ? this.world.cells.get(client.cellId) : undefined;
    const cx = me ? me.x : client.lastPos.x;
    const cy = me ? me.y : client.lastPos.y;
    const zoom = cameraZoom(me ? me.stats.radius : 40, client.view.w, client.view.h);
    const hw = client.view.w / 2 / zoom + 250;
    const hh = client.view.h / 2 / zoom + 250;
    const inView = (x: number, y: number, r = 0) => Math.abs(x - cx) < hw + r && Math.abs(y - cy) < hh + r;

    const cells: number[] = [];
    const infos: CellInfo[] = [];
    for (const c of this.world.cells.values()) {
      if (!c.alive || !inView(c.x, c.y, c.stats.radius * 2)) continue;
      cells.push(c.id, round1(c.x), round1(c.y), round2(c.heading), round1(c.stats.radius), round2(c.hp / c.stats.maxHp), flagsOf(c), Math.round(c.vx), Math.round(c.vy));
      if (client.known.get(c.id) !== c.infoVersion) {
        client.known.set(c.id, c.infoVersion);
        infos.push({ id: c.id, name: c.name, hue: c.hue, level: c.level, ai: c.kind === 'ai', organelles: c.organelles.map((o) => ({ ...o })), version: c.infoVersion });
      }
    }
    if (client.known.size > 400) {
      for (const id of client.known.keys()) if (!this.world.cells.has(id)) client.known.delete(id);
    }

    const snap: Snapshot = { t: Math.round(this.world.time * 1000), cells, clouds: [], you: me ? privateState(me) : null };
    if (infos.length) snap.infos = infos;
    if (this.tick % NUTRIENT_EVERY === 0) {
      const nut: number[] = [];
      this.world.nutrientGrid.query(cx - hw, cy - hh, cx + hw, cy + hh, (n) => {
        nut.push(n.id, Math.round(n.x), Math.round(n.y), n.kind);
      });
      snap.nutrients = nut;
    }
    for (const cl of this.world.clouds) {
      if (inView(cl.x, cl.y, cl.r)) snap.clouds.push(cl.id, Math.round(cl.x), Math.round(cl.y), Math.round(cl.r), round2(cl.life / cl.maxLife));
    }
    client.socket.emit('snap', snap);

    const mine = events.filter((ev) => {
      switch (ev.e) {
        case 'kill':
          return true;
        case 'level':
        case 'dash':
        case 'eat': {
          const c = this.world.cells.get(ev.id);
          return ev.id === client.cellId || (c ? inView(c.x, c.y) : false);
        }
        default:
          return inView(ev.x, ev.y, 100);
      }
    });
    if (mine.length) client.socket.emit('events', mine);
  }
}

function privateState(c: Cell): PrivateState {
  return {
    hp: Math.round(c.hp * 10) / 10,
    maxHp: Math.round(c.stats.maxHp),
    energy: Math.round(c.energy * 10) / 10,
    energyMax: Math.round(c.stats.energyMax),
    xp: Math.floor(c.xp),
    xpNext: xpToNext(c.level),
    level: c.level,
    biomass: Math.round(c.biomass * 10) / 10,
    kills: c.kills,
    pendingEvolutions: c.pendingEvolutions,
    dashCd: round2(c.dashCd),
    dashMaxCd: c.level >= APEX_LEVEL ? DASH_COOLDOWN * 0.7 : DASH_COOLDOWN,
    toxinCd: round2(c.toxinCd),
    hasToxin: c.stats.toxins.length > 0,
    capacity: capacityForLevel(c.level),
    capacityUsed: capacityUsed(c.organelles),
    protectedFor: round2(Math.max(c.spawnProtect, c.evolveProtect)),
    apex: c.level >= APEX_LEVEL,
  };
}

function flagsOf(c: Cell): number {
  let f = 0;
  if (c.spawnProtect > 0) f |= CellFlag.SpawnProtected;
  if (c.evolving) f |= CellFlag.Evolving;
  if (c.poison.time > 0) f |= CellFlag.Poisoned;
  if (c.dashTime > 0) f |= CellFlag.Dashing;
  if (c.kind === 'ai') f |= CellFlag.AI;
  if (c.regenActive) f |= CellFlag.Regenerating;
  if (c.poison.time > 0 && c.poison.slow > 0) f |= CellFlag.Slowed;
  if (c.bleed.time > 0) f |= CellFlag.Bleeding;
  return f;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const clampNum = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

export function sanitizeName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _\-.!?]/gu, '')
    .trim()
    .slice(0, NAME_MAX);
  return s || 'Nameless Cell';
}

export class RoomManager {
  private rooms: Room[] = [];
  private counter = 0;
  constructor(private io: Server<ClientToServer, ServerToClient>) {}

  /** Simple matchmaking: first room with space, otherwise a new one. */
  assign(): Room {
    let room = this.rooms.find((r) => r.playerCount < MAX_PLAYERS_PER_ROOM);
    if (!room) {
      room = new Room(`room-${++this.counter}`, this.io);
      room.start();
      this.rooms.push(room);
    }
    return room;
  }

  get all() {
    return this.rooms;
  }
}
