import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * Unit and integration suites run in the plain Node environment against the
 * pinned minimum runtime inside the development container (see Makefile).
 * Component (happy-dom) and E2E (Playwright) projects are layered on top of
 * this base configuration by later tasks.
 */
export default defineConfig({
  test: {
    include: ["test/{unit,integration}/**/*.spec.ts"],
    environment: "node",
    // Deterministic by default: no file watching, stable order.
    sequence: {
      sort: "path",
    },
  },
});
