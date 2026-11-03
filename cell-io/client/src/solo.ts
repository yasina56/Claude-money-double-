/**
 * Offline mode: runs the real server Room in the browser and connects to it
 * through an in-memory socket pair, so the game can be hosted as static files.
 */
import type { Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '../../shared/protocol';
import { Room } from '../../server/room';

type Handler = (...args: unknown[]) => void;

class LocalEnd {
  id = 'local-' + Math.random().toString(36).slice(2);
  connected = true;
  peer!: LocalEnd;
  private handlers = new Map<string, Handler[]>();
  on(ev: string, fn: Handler) {
    (this.handlers.get(ev) ?? this.handlers.set(ev, []).get(ev)!).push(fn);
    return this;
  }
  once(ev: string, fn: Handler) {
    const wrap: Handler = (...a) => {
      this.off(ev, wrap);
      fn(...a);
    };
    return this.on(ev, wrap);
  }
  off(ev: string, fn: Handler) {
    this.handlers.set(ev, (this.handlers.get(ev) ?? []).filter((h) => h !== fn));
    return this;
  }
  /** Deliver asynchronously, like a real socket, with a structured clone so neither side shares objects. */
  emit(ev: string, ...args: unknown[]) {
    const copy = args.map((a) => (a === undefined ? a : structuredClone(a)));
    setTimeout(() => this.peer.dispatch(ev, copy), 0);
    return true;
  }
  dispatch(ev: string, args: unknown[]) {
    for (const h of [...(this.handlers.get(ev) ?? [])]) h(...args);
  }
  join() {}
  close() {}
}

export function createLocalSocket(): Socket<ServerToClient, ClientToServer> {
  const client = new LocalEnd();
  const server = new LocalEnd();
  client.peer = server;
  server.peer = client;
  const fakeIo = { to: () => ({ emit: (ev: string, data: unknown) => server.emit(ev, data) }) };
  const room = new Room('offline', fakeIo as never);
  room.addClient(server as never);
  room.start();
  setTimeout(() => client.dispatch('connect', []), 0);
  return client as unknown as Socket<ServerToClient, ClientToServer>;
}
