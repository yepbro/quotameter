import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * Projects: `unit` and `integration` run in the plain Node environment;
 * `component` runs Vue component tests under happy-dom. All projects run
 * against the pinned minimum runtime inside the development container.
 * E2E browser tests use Playwright separately (playwright.config.ts).
 */
export default defineConfig({
  test: {
    sequence: {
      // Deterministic by default: no file watching, stable order.
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
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.spec.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.spec.ts"],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: "component",
          environment: "happy-dom",
          include: ["test/component/**/*.spec.ts"],
        },
      },
    ],
  },
});
