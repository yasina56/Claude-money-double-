import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientToServer, ServerToClient, Snapshot, Welcome } from '../shared/protocol';
import { RoomManager, sanitizeName } from '../server/room';

let url = '';
let ioServer: Server<ClientToServer, ServerToClient>;
let rooms: RoomManager;
const http = createServer();

beforeAll(async () => {
  ioServer = new Server(http);
  rooms = new RoomManager(ioServer);
  ioServer.on('connection', (s) => rooms.assign().addClient(s));
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterAll(() => {
  for (const r of rooms.all) r.stop();
  ioServer.close();
  http.close();
});

function client(name: string) {
  const s: Socket<ServerToClient, ClientToServer> = connect(url, { transports: ['websocket'], forceNew: true });
  const welcome = new Promise<Welcome>((resolve) => {
    s.on('welcome', (w) => {
      if (w.id) resolve(w);
    });
  });
  s.on('connect', () => s.emit('join', { name }));
  return { s, welcome };
}

const next = <T>(s: Socket<ServerToClient, ClientToServer>, ev: 'snap' | 'leaderboard' | 'evolveResult') =>
  new Promise<T>((resolve) => s.once(ev as 'snap', resolve as never));

describe('multiplayer room', () => {
  it('two clients join the same room, get snapshots, and the server rejects invalid evolutions', async () => {
    const a = client('Alpha');
    const b = client('Beta<script>');
    const [wa, wb] = await Promise.all([a.welcome, b.welcome]);
    expect(wa.id).not.toBe(wb.id);
    expect(wa.roomId).toBe(wb.roomId);

    const snap = await next<Snapshot>(a.s, 'snap');
    expect(snap.you).not.toBeNull();
    expect(snap.cells.length).toBeGreaterThan(0);
    expect(snap.infos?.some((i) => i.id === wa.id)).toBe(true);

    const lb = await next<{ name: string }[]>(b.s, 'leaderboard');
    expect(Array.isArray(lb)).toBe(true);

    // Input is applied server side.
    a.s.emit('input', { a: 0, t: 1 });
    // Evolving without a pending level is rejected.
    a.s.emit('evolveChoose', { index: 0, slot: 0, tilt: 0 });
    const res = await next<{ ok: boolean }>(a.s, 'evolveResult');
    expect(res.ok).toBe(false);

    const room = rooms.all[0];
    expect([...room.world.cells.values()].some((c) => c.name === 'Betascript')).toBe(true);
    a.s.close();
    b.s.close();
  }, 10000);

  it('sanitizes names', () => {
    expect(sanitizeName('<img src=x>')).toBe('img srcx');
    expect(sanitizeName('')).toBe('Nameless Cell');
    expect(sanitizeName('a'.repeat(50))).toHaveLength(16);
  });
});
