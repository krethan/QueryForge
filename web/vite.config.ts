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
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks: CodeMirror is only pulled in by the report editor route.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](@codemirror|@lezer|codemirror|@uiw|style-mod|w3c-keyname|crelt)[\\/]/.test(id))
            return 'codemirror';
          if (/[\\/]@carbon[\\/]icons-react[\\/]/.test(id)) return 'carbon-icons';
          if (/[\\/](@carbon|@floating-ui|@ibm|downshift|tabbable|focus-trap)[\\/]/.test(id))
            return 'carbon';
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return 'react';
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    server: { deps: { inline: [/@carbon/] } },
  },
});
