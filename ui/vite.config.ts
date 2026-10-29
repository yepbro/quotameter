import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * Vite configuration for the bundled web UI.
 *
 * The UI is built into `ui/dist` and served by the application server; it
 * never talks to providers directly (spec §14). Container runs redirect the
 * build output via DIST_DIR (see compose.yaml) so host- and container-built
 * directories never fight over ownership.
 */
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: process.env.DIST_DIR ?? 'dist',
  },
});
