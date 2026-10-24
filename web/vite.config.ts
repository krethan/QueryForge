/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.QF_API_URL ?? 'http://localhost:3001', changeOrigin: false },
    },
  },
  css: {
    preprocessorOptions: {
      scss: { api: 'modern-compiler', quietDeps: true, silenceDeprecations: ['mixed-decls'] },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2500 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    server: { deps: { inline: [/@carbon/] } },
  },
});
