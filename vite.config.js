import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    base: 'america-trip',
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
});
