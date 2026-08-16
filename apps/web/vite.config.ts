/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Proxying /api in dev mirrors how Caddy will route in production: the app
// only ever calls relative paths, never a hardcoded server origin.
const API_PROXY_TARGET = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
      },
      // The realtime gateway (`RealtimeGateway`, M2b.4) listens on this same path — `ws: true`
      // is what makes Vite proxy the websocket upgrade itself, not just plain HTTP requests to
      // it (an `/api`-style proxy entry alone would leave the handshake never reaching the API
      // server in dev).
      '/ws': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
