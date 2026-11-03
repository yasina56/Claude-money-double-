import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const SERVER_PORT = Number(process.env.PORT ?? 3001);

export default defineConfig({
  root: resolve(__dirname, 'client'),
  publicDir: false,
  // Relative asset paths so the offline build works from any static host.
  base: process.env.VITE_OFFLINE === '1' ? './' : '/',
  resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
  server: {
    port: 5173,
    host: true,
    proxy: { '/socket.io': { target: `http://localhost:${SERVER_PORT}`, ws: true } },
  },
  build: {
    outDir: resolve(__dirname, process.env.VITE_OFFLINE === '1' ? 'dist/offline' : 'dist/client'),
    target: 'es2022',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
