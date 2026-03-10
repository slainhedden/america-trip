import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const GITHUB_PAGES_BASE = '/america-trip/';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' ? '/' : GITHUB_PAGES_BASE,
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('maplibre-gl')) {
            return 'maplibre';
          }

          if (id.includes('react-map-gl')) {
            return 'map-ui';
          }

          if (id.includes('react-dom') || id.includes('/react/')) {
            return 'react-vendor';
          }

          return undefined;
        },
      },
    },
  },
}));
