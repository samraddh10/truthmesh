import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_PREFIXES = [
  '/collections',
  '/documents',
  '/facts',
  '/relationships',
  '/runs',
  '/settings',
  '/health',
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@superjoin/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [
        prefix,
        { target: process.env['VITE_API_TARGET'] ?? 'http://localhost:3000', changeOrigin: true },
      ]),
    ),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
