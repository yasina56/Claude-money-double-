/** CELL.IO server entry: HTTP (serves the built client in production) + Socket.IO. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import type { ClientToServer, ServerToClient } from '../shared/protocol';
import { RoomManager } from './room';

const PORT = Number(process.env.PORT ?? 3001);
const here = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = resolve(here, '../dist/client');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.all.map((r) => ({ id: r.id, players: r.playerCount, cells: r.world.cells.size })) }));
    return;
  }
  if (!existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('CELL.IO game server is running. In development open the Vite client at http://localhost:5173. For production run `npm run build` first.');
    return;
  }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

const io = new Server<ClientToServer, ServerToClient>(http, {
  cors: { origin: true },
  perMessageDeflate: { threshold: 1024 },
});
const rooms = new RoomManager(io);

io.on('connection', (socket) => {
  rooms.assign().addClient(socket);
});

http.listen(PORT, () => {
  console.log(`CELL.IO server listening on http://localhost:${PORT}`);
});
