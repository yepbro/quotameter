import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * Vite configuration for the bundled web UI (spec §3, §14.1; decisions
 * D-127 and D-129).
 *
 * The UI is built into `ui/dist` and served by the application server; it
 * never talks to providers directly (spec §14). Container runs redirect
 * the build output via DIST_DIR (see compose.yaml) so host- and
 * container-built directories never fight over ownership.
 *
 * The output must satisfy the served CSP (D-127): external hashed bundles
 * only — no inline scripts or stylesheets, and no `data:` URIs, which
 * `img-src`/`font-src 'self'` refuse. Vite's defaults already emit
 * external bundles; the two explicit settings below pin the rest, and
 * `npm run verify:build` asserts the shape on every build.
 */
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: process.env.DIST_DIR ?? 'dist',
    // CSP (D-127): img-src/font-src 'self' admits no `data:` URIs, so an
    // asset must never be inlined however small — Vite's default 4096-byte
    // limit would inline exactly those as data URIs.
    assetsInlineLimit: 0,
    // DIST_DIR (container runs) sits outside the Vite root, where Vite
    // refuses to clean the output directory on its own; stale hashed
    // assets would accumulate in the volume and stay servable.
    emptyOutDir: true,
  },
});
