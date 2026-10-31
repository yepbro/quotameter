import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Spec §17.3 (decision D-085): critical modules are held at 100% on every
// axis, judged per matching file (`perFile`) so a shortfall fails the run
// naming the exact file and axis, while the top-level numbers keep judging
// the aggregate of all files. Category → module map: time-zone logic —
// clock and rolling ranges (§10); peak-hours — the `peak-hours*` family
// (§9.3), so service files still landing join as they appear; sanitization
// — the response sanitizer (§7.4); secret-handling (§15.4) — the redacting
// logger, config permission enforcement, and atomic config writes; since
// U-016 (decision D-089) also the configuration-loading mechanics —
// `src/config/env.ts`, `load.ts`, `reload.ts` — and the shared transport
// `src/providers/transport.ts`, each lifted to its measured maximum first.
// Three single-branch arms inside those files are unreachable by
// construction and are the only sanctioned exceptions (D-089): their keys
// pin the achievable maximum instead of 100, so any NEW uncovered arm
// (dropping the file 0.86–2.78 pp below its pinned maximum) still fails
// the gate —
// • `env.ts` branches 97.67 — the unknown-name sort comparator's equal-key
//   arm: object keys are unique (the Proxy ownKeys invariant enforces it
//   too) and string `<`/`>` is a total order, so "neither less nor
//   greater" is impossible;
// • `load.ts` branches 99.13 — the schema-growth fallback "must be one of
//   the allowed values": every ConfigSchema union is literal-only today,
//   so Ajv always emits const line-mates for a failed anyOf;
// • `reload.ts` branches 97.22 — the `?? CONFIG_DEFAULTS.logging.level`
//   fallback: the canonical parser always materializes `logging.level`
//   and no injection seam bypasses it.
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
      // list is held at 100% (or the documented per-axis maximum — see the
      // U-016 exception notes above and decision D-089).
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
        'src/providers/transport.ts': criticalModuleThreshold,
        // Branch maxima below 100: one unreachable arm each (D-089).
        'src/config/env.ts': { ...criticalModuleThreshold, branches: 97.67 },
        'src/config/load.ts': { ...criticalModuleThreshold, branches: 99.13 },
        'src/config/reload.ts': { ...criticalModuleThreshold, branches: 97.22 },
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
