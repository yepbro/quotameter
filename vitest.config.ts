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
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Container runs write into the isolated data volume (see compose.yaml)
      // so host- and container-generated reports never fight over ownership.
      reportsDirectory: process.env.COVERAGE_DIR ?? "coverage",
      reporter: ["text", "json-summary", "html"],
      // Spec §17.3: the overall project target is 90%. The baseline enforces
      // the same number from day one so thresholds can only be tightened.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
