import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const SERVER_PORT = Number(process.env.PORT ?? 3001);

export default defineConfig({
  root: resolve(__dirname, 'client'),
  publicDir: false,
  resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
  server: {
    port: 5173,
    host: true,
    proxy: { '/socket.io': { target: `http://localhost:${SERVER_PORT}`, ws: true } },
  },
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
