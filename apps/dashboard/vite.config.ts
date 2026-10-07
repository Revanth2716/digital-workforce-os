import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard talks to the local API over HTTP. In dev, Vite
// proxies /api and /health to the backend so the app needs no
// hard-coded host and no CORS relaxation.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4317',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4317',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Local tool: no telemetry, no upload of anything anywhere.
    chunkSizeWarningLimit: 900,
  },
});