import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TUTORIAL_XP_MULT } from '../shared/constants';
import type { ClientToServer, DeathStats, GameEvent, ServerToClient, Welcome } from '../shared/protocol';
import { World } from '../shared/sim/world';
import { RoomManager } from '../server/room';

describe('tutorial XP boost (world rule)', () => {
  it('doubles nutrient XP for a tutorial cell until level 2, and only then', () => {
    const w = new World({ seed: 3, nutrientTarget: 0, crystalTarget: 0, hazards: false });
    const tut = w.addCell('player', 'new');
    const normal = w.addCell('player', 'old');
    tut.tutorial = true;
    for (const c of [tut, normal]) {
      c.x = c === tut ? 1000 : 3000;
      c.y = 1000;
      for (let i = 0; i < 5; i++) w.spawnNutrient(false, { x: c.x, y: c.y }, 1);
    }
    w.step(1 / 40);
    expect(tut.xp).toBe(normal.xp * TUTORIAL_XP_MULT);
    // At level 2 the boost is gone.
    tut.level = 2;
    tut.xp = 0;
    for (let i = 0; i < 5; i++) w.spawnNutrient(false, { x: tut.x, y: tut.y }, 1);
    w.step(1 / 40);
    expect(tut.xp).toBe(5);
  });

  it('kill events say what finished the victim', () => {
    const w = new World({ seed: 3, nutrientTarget: 0, crystalTarget: 0, hazards: false });
    const a = w.addCell('player', 'a');
    const v = w.addCell('player', 'v');
    a.spawnProtect = v.spawnProtect = 0;
    w.damage(v, 5, a, 'spike', v.x, v.y, false);
    w.kill(v);
    const kill = w.events.find((e) => e.e === 'kill') as Extract<GameEvent, { e: 'kill' }>;
    expect(kill.how).toBe('spike');
  });
});

describe('onboarding over the network', () => {
  let url = '';
  let io: Server<ClientToServer, ServerToClient>;
  let rooms: RoomManager;
  const http = createServer();
  beforeAll(async () => {
    io = new Server(http);
    rooms = new RoomManager(io);
    io.on('connection', (s) => rooms.assign().addClient(s));
    await new Promise<void>((r) => http.listen(0, r));
    url = `http://localhost:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    for (const r of rooms.all) r.stop();
    io.close();
    http.close();
  });

  const join = (s: Socket<ServerToClient, ClientToServer>, tutorial: boolean) =>
    new Promise<Welcome>((resolve) => {
      const on = (w: Welcome) => {
        if (w.id) {
          s.off('welcome', on);
          resolve(w);
        }
      };
      s.on('welcome', on);
      s.emit('join', { name: 'tut', tutorial });
    });

  it('grants the tutorial boost once per connection', async () => {
    const s: Socket<ServerToClient, ClientToServer> = connect(url, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', () => r(null)));
    const w1 = await join(s, true);
    const room = rooms.all.find((r) => r.world.cells.has(w1.id))!;
    expect(room.world.cells.get(w1.id)!.tutorial).toBe(true);
    const w2 = await join(s, true); // asking again on the same connection
    expect(room.world.cells.get(w2.id)!.tutorial).toBe(false);
    s.close();
  }, 10000);

  it('after a kill, the view of the victim follows the killer before the death screen', async () => {
    const s: Socket<ServerToClient, ClientToServer> = connect(url, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', () => r(null)));
    const w = await join(s, false);
    const room = rooms.all.find((r) => r.world.cells.has(w.id))!;
    const me = room.world.cells.get(w.id)!;
    const killer = room.world.addCell('ai', 'Didinium');
    killer.x = 4000;
    killer.y = 4000;
    me.lastHitBy = killer.id;
    me.lastHitAt = room.world.time;
    const died = new Promise<DeathStats>((r) => s.once('died', r));
    room.world.kill(me);
    const stats = await died;
    expect(stats.killerId).toBe(killer.id);
    await new Promise((r) => setTimeout(r, 250));
    const client = [...room.clients.values()].find((c) => c.socket.id === s.id)!;
    expect(client.spectate?.id).toBe(killer.id);
    expect(Math.hypot(client.lastPos.x - killer.x, client.lastPos.y - killer.y)).toBeLessThan(300);
    s.close();
  }, 10000);
});
