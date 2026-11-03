/**
 * Smoke test: boots the real server on a random port, connects several
 * Socket.IO clients, steers them for a few seconds, evolves one of them with a
 * valid placement, and checks that snapshots, nutrient deltas, prediction acks,
 * the leaderboard and /health all behave. Exits non-zero on any failure.
 *
 *   npm run smoke
 */
import { spawn } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, EvolutionOffer, ServerToClient, Snapshot } from '../shared/protocol';
import { NUTRIENT_FIELDS } from '../shared/protocol';
import { ORGANELLES } from '../shared/organelles';
import { validSlots } from '../shared/placement';

const PORT = 4100 + Math.floor(Math.random() * 800);
const URL = `http://localhost:${PORT}`;
const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), CELLIO_DEV: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => (serverErr += d));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${URL}/health`);
      if (r.ok) return (await r.json()) as { ok: boolean };
    } catch {
      /* not up yet */
    }
    await wait(250);
  }
  throw new Error('server did not start');
}

interface Bot {
  s: Socket<ServerToClient, ClientToServer>;
  id: number;
  snaps: number;
  nutrients: Set<number>;
  first: Snapshot | null;
  last: Snapshot | null;
  offers: EvolutionOffer | null;
}

function bot(name: string): Promise<Bot> {
  return new Promise((resolve) => {
    const s: Socket<ServerToClient, ClientToServer> = io(URL, { transports: ['websocket'], forceNew: true });
    const b: Bot = { s, id: 0, snaps: 0, nutrients: new Set(), first: null, last: null, offers: null };
    s.on('connect', () => s.emit('join', { name }));
    s.on('welcome', (w) => {
      if (w.id) {
        b.id = w.id;
        resolve(b);
      }
    });
    s.on('snap', (snap) => {
      b.snaps++;
      if (!b.first && snap.you) b.first = snap;
      b.last = snap;
      if (snap.nFull) b.nutrients.clear();
      const add = snap.nAdd ?? [];
      for (let i = 0; i + NUTRIENT_FIELDS <= add.length; i += NUTRIENT_FIELDS) b.nutrients.add(add[i]);
      for (const id of snap.nDel ?? []) b.nutrients.delete(id);
    });
    s.on('evolveOffer', (o) => (b.offers = o));
  });
}

async function main() {
  const health = await waitForServer();
  check(health.ok === true, '/health responds');

  const bots = await Promise.all(['smoke-a', 'smoke-b', 'smoke-c', 'smoke-d'].map(bot));
  check(new Set(bots.map((b) => b.id)).size === 4, 'four clients joined with distinct ids');

  let seq = 0;
  const steer = setInterval(() => {
    seq++;
    bots.forEach((b, i) => b.s.emit('input', { a: (i * Math.PI) / 2 + seq * 0.02, t: 1, seq }));
  }, 50);

  await wait(3000);
  for (const b of bots) {
    check(b.snaps >= 40, `${b.s.id?.slice(0, 4)} received ${b.snaps} snapshots in 3 s`);
    const a = b.first?.you;
    const z = b.last?.you;
    check(!!a && !!z && Math.hypot(z.x - a.x, z.y - a.y) > 100, 'cell moved under server authority');
    check((z?.ack ?? 0) > 0, `input acks advance (ack=${z?.ack})`);
    check(b.nutrients.size > 20, `nutrient deltas build a visible set (${b.nutrients.size})`);
  }

  // Evolve bot A through the real protocol with a valid placement.
  const A = bots[0];
  A.s.emit('devXp', 30);
  await wait(300);
  A.s.emit('evolveOpen');
  await wait(300);
  check(!!A.offers && A.offers.offers.length === 3, 'evolution offers received');
  const idx = A.offers?.offers.findIndex((o) => o.kind === 'new') ?? -1;
  const offer = A.offers?.offers[idx];
  if (offer && offer.kind === 'new') {
    const slot = validSlots([], offer.type)[0];
    const result = new Promise<{ ok: boolean; error?: string }>((r) => A.s.once('evolveResult', r));
    A.s.emit('evolveChoose', { index: idx, slot, tilt: 0 });
    const r = await result;
    check(r.ok, `valid ${ORGANELLES[offer.type].name} placement accepted`);
  }
  // A forged placement must be rejected.
  const bad = new Promise<{ ok: boolean }>((r) => A.s.once('evolveResult', r));
  A.s.emit('evolveChoose', { index: 0, slot: 999, tilt: 9 });
  check(!(await bad).ok, 'forged evolution rejected');

  const lb = await new Promise<unknown[]>((r) => A.s.once('leaderboard', r));
  check(Array.isArray(lb) && lb.length > 0, 'leaderboard broadcast');

  clearInterval(steer);
  bots.forEach((b) => b.s.close());
  check(!/Error|TypeError/.test(serverErr), 'server stderr is clean');
}

main()
  .catch((e) => failures.push(String(e)))
  .finally(() => {
    server.kill();
    if (serverErr) console.log(serverErr.slice(0, 2000));
    console.log(failures.length ? `\nSMOKE FAILED (${failures.length})` : '\nSMOKE PASSED');
    process.exit(failures.length ? 1 : 0);
  });
