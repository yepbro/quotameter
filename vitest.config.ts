import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Spec §17.3 (decision D-085): critical modules are held at 100% on every
// axis, judged per matching file (`perFile`) so a shortfall fails the run
// naming the exact file and axis, while the top-level numbers keep judging
// the aggregate of all files. Category → module map: time-zone logic —
// clock and rolling ranges (§10); peak-hours — the `peak-hours*` family
// (§9.3), so service files still landing join as they appear; sanitization
// — the response sanitizer (§7.4); secret-handling (§15.4) — the redacting
// logger, config permission enforcement, and atomic config writes. No
// threshold exceptions: every listed module measures 100% on all four axes.
// `src/config/env.ts`, `load.ts`, and `reload.ts` are deliberately outside
// the secret-handling set — configuration-loading mechanics (§6), not
// secret protection (their measured branch coverage is below 100 today);
// so is `src/providers/transport.ts` (§8.1 transport whose error paths
// scrub secrets — a protection aspect, not its whole job; 95.45%
// functions today). See D-085 for the boundary and the widening path.
const criticalModuleThreshold = {
  statements: 100,
  branches: 100,
  functions: 100,
  lines: 100,
  perFile: true,
} as const;

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
      // Deterministic by default: stable file/suite ordering.
      shuffle: false,
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Container runs write into the isolated data volume (see compose.yaml)
      // so host- and container-generated reports never fight over ownership.
      reportsDirectory: process.env.COVERAGE_DIR ?? 'coverage',
      reporter: ['text', 'json-summary', 'html'],
      // Spec §17.3: the overall project target is 90%; the critical-module
      // list is held at 100% — see `criticalModuleThreshold` above.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        'src/util/clock.ts': criticalModuleThreshold,
        'src/util/rolling-ranges.ts': criticalModuleThreshold,
        'src/services/peak-hours*.ts': criticalModuleThreshold,
        'src/providers/sanitize.ts': criticalModuleThreshold,
        'src/util/logger.ts': criticalModuleThreshold,
        'src/config/permissions.ts': criticalModuleThreshold,
        'src/config/write.ts': criticalModuleThreshold,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.spec.ts'],
          setupFiles: ['test/helpers/network-guard.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.spec.ts'],
          setupFiles: ['test/helpers/network-guard.ts'],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'component',
          environment: 'happy-dom',
          include: ['test/component/**/*.spec.ts'],
          setupFiles: ['test/helpers/network-guard.ts'],
        },
      },
    ],
  },
});
