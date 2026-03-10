import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

type PackageMetadata = {
  homepage?: string;
};

function getGithubPagesBase(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as PackageMetadata;
    if (!packageJson.homepage) {
      return '/';
    }

    const pathname = new URL(packageJson.homepage).pathname.replace(/\/+$/, '');
    return pathname ? `${pathname}/` : '/';
  } catch {
    return '/';
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' ? '/' : getGithubPagesBase(),
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
