import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/**
 * Vite configuration for the bundled web UI.
 *
 * The UI is built into `ui/dist` and served by the application server; it
 * never talks to providers directly (spec §14).
 */
export default defineConfig({
  plugins: [vue()],
});
